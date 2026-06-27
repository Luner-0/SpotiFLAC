package backend

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
)

// In-app key + BPM estimation (pure DSP, no ML, permissive). This is a real
// HPCP-style analyzer: spectral peak-picking with parabolic interpolation,
// harmonic summation (fold overtones back to the fundamental), tuning estimation,
// per-segment key voting, and a multi-band onset envelope with perceptually-
// weighted tempo search. It is still an estimate (rekordbox/ML do better) and is
// flagged as such in the UI, but it is far better than a naive FFT chromagram.

// AudioAnalysis is the result returned to the frontend.
type AudioAnalysis struct {
	Key        string  `json:"key"`        // e.g. "Am", "F#"
	Camelot    string  `json:"camelot"`    // e.g. "8A"
	BPM        int     `json:"bpm"`        // 0 if undetermined
	Confidence float64 `json:"confidence"` // 0..1 key-detection confidence
}

const (
	analysisSampleRate = 11025 // key lives below ~2kHz; downsampling speeds everything up
	chromaFFT          = 8192  // ~1.35Hz bins at 11025Hz → resolves bass semitones
	chromaHop          = 4096
	onsetFFT           = 1024
	onsetHop           = 256
	noteNamesSharp     = "C C# D D# E F F# G G# A A# B"
)

// Krumhansl-Kessler key profiles (tonic-relative). Easy to swap during tuning.
var keyProfileMajor = [12]float64{6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88}
var keyProfileMinor = [12]float64{6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17}

// AnalyzeAudioFile decodes a local file and estimates its key/BPM.
func AnalyzeAudioFile(path string) (*AudioAnalysis, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("file path is required")
	}
	samples, err := decodeMonoFloat(path, false, 0)
	if err != nil {
		return nil, err
	}
	return analyzeSamples(samples, analysisSampleRate)
}

// AnalyzeAudioURL decodes a remote URL (Spotify preview / yt-dlp stream) and
// estimates its key/BPM, so not-yet-downloaded nodes can still be analyzed.
func AnalyzeAudioURL(url string) (*AudioAnalysis, error) {
	if strings.TrimSpace(url) == "" {
		return nil, fmt.Errorf("url is required")
	}
	samples, err := decodeMonoFloat(url, true, 150)
	if err != nil {
		return nil, err
	}
	return analyzeSamples(samples, analysisSampleRate)
}

// decodeMonoFloat shells out to ffmpeg to get mono float32 PCM at the analysis
// sample rate. maxSeconds>0 caps the duration (used for streams).
func decodeMonoFloat(input string, isURL bool, maxSeconds int) ([]float64, error) {
	ffmpegPath, err := GetFFmpegPath()
	if err != nil {
		return nil, err
	}
	args := []string{"-v", "error"}
	if maxSeconds > 0 {
		args = append(args, "-t", strconv.Itoa(maxSeconds))
	}
	args = append(args,
		"-i", input,
		"-vn",
		"-map", "0:a:0",
		"-ac", "1",
		"-ar", strconv.Itoa(analysisSampleRate),
		"-f", "f32le",
		"-acodec", "pcm_f32le",
		"pipe:1",
	)
	var stdout, stderr bytes.Buffer
	cmd := exec.Command(ffmpegPath, args...)
	setHideWindow(cmd)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg decode failed: %w - %s", err, strings.TrimSpace(stderr.String()))
	}
	raw := stdout.Bytes()
	n := len(raw) / 4
	if n == 0 {
		return nil, fmt.Errorf("no audio samples decoded")
	}
	samples := make([]float64, n)
	for i := 0; i < n; i++ {
		bits := binary.LittleEndian.Uint32(raw[i*4:])
		samples[i] = float64(math.Float32frombits(bits))
	}
	return samples, nil
}

func analyzeSamples(samples []float64, sr int) (*AudioAnalysis, error) {
	if len(samples) < sr {
		return nil, fmt.Errorf("audio too short to analyze")
	}
	pc, minor, conf := detectKeyVoted(samples, sr)
	bpm := detectTempo(samples, sr)
	notes := strings.Fields(noteNamesSharp)
	key := notes[pc]
	if minor {
		key += "m"
	}
	var camelot string
	if minor {
		camelot = minorCamelot[pc]
	} else {
		camelot = majorCamelot[pc]
	}
	return &AudioAnalysis{Key: key, Camelot: camelot, BPM: bpm, Confidence: conf}, nil
}

// ---------------- Key detection ----------------

// detectKeyVoted splits the track into overlapping segments, detects a key per
// segment and votes, which is robust to intros/breakdowns/vocal sections.
func detectKeyVoted(samples []float64, sr int) (pc int, minor bool, confidence float64) {
	segLen := sr * 12 // ~12s segments
	if segLen < chromaFFT*2 {
		segLen = chromaFFT * 2
	}
	hop := segLen / 2
	type vote struct {
		score float64
		count float64
	}
	votes := map[int]*vote{} // key index 0..23 (0..11 major, 12..23 minor)
	any := false
	for start := 0; start+chromaFFT <= len(samples); start += hop {
		end := start + segLen
		if end > len(samples) {
			end = len(samples)
		}
		if end-start < chromaFFT {
			break
		}
		chroma := computeChroma(samples[start:end], sr)
		if chroma == nil {
			continue
		}
		k, score := bestKey(chroma)
		v := votes[k]
		if v == nil {
			v = &vote{}
			votes[k] = v
		}
		v.score += score
		v.count++
		any = true
		if end == len(samples) {
			break
		}
	}
	if !any {
		// Fallback: whole-track chroma.
		chroma := computeChroma(samples, sr)
		if chroma == nil {
			return 0, false, 0
		}
		k, score := bestKey(chroma)
		return k % 12, k >= 12, math.Max(0, math.Min(1, (score+1)/2))
	}

	bestK := -1
	var bestScore float64
	var totalCount float64
	for k, v := range votes {
		totalCount += v.count
		if bestK == -1 || v.score > bestScore {
			bestK = k
			bestScore = v.score
		}
	}
	conf := 0.0
	if totalCount > 0 {
		conf = votes[bestK].count / totalCount
	}
	return bestK % 12, bestK >= 12, conf
}

// computeChroma builds a tuning-corrected, harmonic-summed 12-bin chroma vector
// from spectral peaks across the given samples.
func computeChroma(samples []float64, sr int) []float64 {
	if len(samples) < chromaFFT {
		return nil
	}
	window := hannWindow(chromaFFT)
	re := make([]float64, chromaFFT)
	im := make([]float64, chromaFFT)
	bins := chromaFFT/2 + 1
	mag := make([]float64, bins)

	// Pass 1: collect peaks for tuning estimation.
	var tSin, tCos float64
	frames := 0
	for start := 0; start+chromaFFT <= len(samples); start += chromaHop {
		loadFrame(samples, start, window, re, im)
		fft(re, im)
		magnitudes(re, im, mag)
		peaks := pickPeaks(mag, sr, chromaFFT)
		for _, p := range peaks {
			midi := 69 + 12*math.Log2(p.freq/440)
			frac := midi - math.Round(midi)
			ang := 2 * math.Pi * frac
			tSin += p.mag * math.Sin(ang)
			tCos += p.mag * math.Cos(ang)
		}
		frames++
	}
	if frames == 0 {
		return nil
	}
	tuning := 0.0
	if tSin != 0 || tCos != 0 {
		tuning = math.Atan2(tSin, tCos) / (2 * math.Pi)
	}

	// Pass 2: harmonic-summed chroma with tuning correction.
	chroma := make([]float64, 12)
	harmonicWeights := []float64{1.0, 0.5, 0.33, 0.25, 0.2}
	for start := 0; start+chromaFFT <= len(samples); start += chromaHop {
		loadFrame(samples, start, window, re, im)
		fft(re, im)
		magnitudes(re, im, mag)
		peaks := pickPeaks(mag, sr, chromaFFT)
		frame := make([]float64, 12)
		for _, p := range peaks {
			midi := 69 + 12*math.Log2(p.freq/440) - tuning
			// Fold overtones back onto the fundamental: treat the peak as the
			// h-th harmonic and credit the implied fundamental's pitch class.
			for h, w := range harmonicWeights {
				fundMidi := midi - 12*math.Log2(float64(h+1))
				addToChroma(frame, fundMidi, p.mag*w)
			}
		}
		// Per-frame normalize so loud sections don't dominate.
		var sum float64
		for _, v := range frame {
			sum += v
		}
		if sum > 0 {
			for i := range frame {
				chroma[i] += frame[i] / sum
			}
		}
	}
	return chroma
}

// addToChroma distributes energy to the two nearest pitch-class bins (cosine
// weighting) for a smooth, tuning-tolerant chroma.
func addToChroma(chroma []float64, midi, mag float64) {
	pcCont := math.Mod(midi, 12)
	if pcCont < 0 {
		pcCont += 12
	}
	lo := int(math.Floor(pcCont))
	frac := pcCont - float64(lo)
	wLo := math.Pow(math.Cos(frac*math.Pi/2), 2)
	wHi := 1 - wLo
	chroma[lo%12] += mag * wLo
	chroma[(lo+1)%12] += mag * wHi
}

// bestKey correlates the chroma with all 24 rotated profiles, returning the best
// key index (0..11 major, 12..23 minor) and its correlation score.
func bestKey(chroma []float64) (int, float64) {
	bestIdx := 0
	bestScore := math.Inf(-1)
	for r := 0; r < 12; r++ {
		maj := make([]float64, 12)
		min := make([]float64, 12)
		for i := 0; i < 12; i++ {
			maj[i] = keyProfileMajor[((i-r)%12+12)%12]
			min[i] = keyProfileMinor[((i-r)%12+12)%12]
		}
		if s := pearson(chroma, maj); s > bestScore {
			bestScore = s
			bestIdx = r
		}
		if s := pearson(chroma, min); s > bestScore {
			bestScore = s
			bestIdx = r + 12
		}
	}
	return bestIdx, bestScore
}

// ---------------- Tempo detection ----------------

// detectTempo builds a multi-band spectral-flux onset envelope and finds the
// tempo via perceptually-weighted autocorrelation with octave disambiguation.
func detectTempo(samples []float64, sr int) int {
	window := hannWindow(onsetFFT)
	re := make([]float64, onsetFFT)
	im := make([]float64, onsetFFT)
	bins := onsetFFT/2 + 1
	mag := make([]float64, bins)
	prevBand := make([]float64, 0)

	const nBands = 6
	bandEdges := make([]int, nBands+1)
	for b := 0; b <= nBands; b++ {
		// Log-spaced band edges across the bins.
		frac := float64(b) / float64(nBands)
		bandEdges[b] = int(math.Round(math.Pow(float64(bins-1), frac)))
	}

	var env []float64
	for start := 0; start+onsetFFT <= len(samples); start += onsetHop {
		loadFrame(samples, start, window, re, im)
		fft(re, im)
		magnitudes(re, im, mag)
		band := make([]float64, nBands)
		for b := 0; b < nBands; b++ {
			lo := bandEdges[b]
			hi := bandEdges[b+1]
			if lo < 1 {
				lo = 1
			}
			var s float64
			for k := lo; k < hi && k < bins; k++ {
				s += math.Sqrt(mag[k])
			}
			band[b] = s
		}
		if len(prevBand) == nBands {
			var flux float64
			for b := 0; b < nBands; b++ {
				d := band[b] - prevBand[b]
				if d > 0 {
					flux += d
				}
			}
			env = append(env, flux)
		} else {
			env = append(env, 0)
		}
		prevBand = band
	}
	if len(env) < 16 {
		return 0
	}

	fps := float64(sr) / float64(onsetHop)

	// High-pass: subtract a moving average, then rectify.
	smoothed := movingAverage(env, int(math.Round(fps*0.5)))
	for i := range env {
		env[i] -= smoothed[i]
		if env[i] < 0 {
			env[i] = 0
		}
	}

	// Autocorrelation over the candidate BPM range with a log-Gaussian perceptual
	// prior centered on ~120 BPM.
	const minBPM, maxBPM = 50.0, 210.0
	bestBPM := 0.0
	bestScore := math.Inf(-1)
	rawAt := func(bpm float64) float64 {
		lag := (60.0 / bpm) * fps
		li := int(math.Floor(lag))
		if li < 2 || li >= len(env)-1 {
			return 0
		}
		fr := lag - float64(li)
		var s float64
		for i := 0; i+li+1 < len(env); i++ {
			shifted := env[i+li]*(1-fr) + env[i+li+1]*fr
			s += env[i] * shifted
		}
		return s / float64(len(env))
	}
	percWeight := func(bpm float64) float64 {
		l := math.Log2(bpm / 120.0)
		return math.Exp(-0.5 * (l / 0.7) * (l / 0.7))
	}
	for bpm := minBPM; bpm <= maxBPM; bpm += 0.25 {
		score := rawAt(bpm) * percWeight(bpm)
		if score > bestScore {
			bestScore = score
			bestBPM = bpm
		}
	}
	if bestBPM == 0 {
		return 0
	}

	// Octave disambiguation: compare the perceptually-weighted strength of the
	// candidate against its half and double tempos.
	candidates := []float64{bestBPM * 0.5, bestBPM, bestBPM * 2}
	finalBPM := bestBPM
	finalScore := math.Inf(-1)
	for _, c := range candidates {
		if c < minBPM || c > maxBPM {
			continue
		}
		s := rawAt(c) * percWeight(c)
		if s > finalScore {
			finalScore = s
			finalBPM = c
		}
	}
	return int(math.Round(finalBPM))
}

// ---------------- DSP helpers ----------------

type specPeak struct {
	freq float64
	mag  float64
}

// pickPeaks finds parabolically-interpolated local maxima above a relative floor.
func pickPeaks(mag []float64, sr, fftSize int) []specPeak {
	bins := len(mag)
	var maxMag float64
	for _, m := range mag {
		if m > maxMag {
			maxMag = m
		}
	}
	if maxMag <= 0 {
		return nil
	}
	floor := maxMag * 1e-4
	minBin := int(math.Floor(40.0 * float64(fftSize) / float64(sr)))   // ~40Hz
	maxBin := int(math.Ceil(2200.0 * float64(fftSize) / float64(sr)))  // ~2.2kHz
	if minBin < 1 {
		minBin = 1
	}
	if maxBin > bins-2 {
		maxBin = bins - 2
	}
	var peaks []specPeak
	for k := minBin; k <= maxBin; k++ {
		if mag[k] <= floor {
			continue
		}
		if mag[k] < mag[k-1] || mag[k] < mag[k+1] {
			continue
		}
		// Parabolic interpolation for sub-bin frequency precision.
		denom := mag[k-1] - 2*mag[k] + mag[k+1]
		delta := 0.0
		if denom != 0 {
			delta = 0.5 * (mag[k-1] - mag[k+1]) / denom
		}
		trueBin := float64(k) + delta
		freq := trueBin * float64(sr) / float64(fftSize)
		if freq <= 0 {
			continue
		}
		peaks = append(peaks, specPeak{freq: freq, mag: mag[k]})
	}
	return peaks
}

func loadFrame(samples []float64, start int, window, re, im []float64) {
	n := len(window)
	for j := 0; j < n; j++ {
		idx := start + j
		if idx < len(samples) {
			re[j] = samples[idx] * window[j]
		} else {
			re[j] = 0
		}
		im[j] = 0
	}
}

func magnitudes(re, im, out []float64) {
	for k := range out {
		out[k] = re[k]*re[k] + im[k]*im[k] // power
	}
}

func hannWindow(n int) []float64 {
	w := make([]float64, n)
	for i := 0; i < n; i++ {
		w[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(n-1))
	}
	return w
}

func movingAverage(x []float64, win int) []float64 {
	if win < 1 {
		win = 1
	}
	out := make([]float64, len(x))
	var sum float64
	half := win / 2
	// Simple prefix-sum based centered average.
	prefix := make([]float64, len(x)+1)
	for i, v := range x {
		sum += v
		prefix[i+1] = sum
	}
	for i := range x {
		lo := i - half
		hi := i + half + 1
		if lo < 0 {
			lo = 0
		}
		if hi > len(x) {
			hi = len(x)
		}
		out[i] = (prefix[hi] - prefix[lo]) / float64(hi-lo)
	}
	return out
}

func pearson(a, b []float64) float64 {
	n := len(a)
	if n == 0 || len(b) != n {
		return 0
	}
	var sa, sb float64
	for i := 0; i < n; i++ {
		sa += a[i]
		sb += b[i]
	}
	ma := sa / float64(n)
	mb := sb / float64(n)
	var num, da, db float64
	for i := 0; i < n; i++ {
		xa := a[i] - ma
		xb := b[i] - mb
		num += xa * xb
		da += xa * xa
		db += xb * xb
	}
	denom := math.Sqrt(da * db)
	if denom == 0 {
		return 0
	}
	return num / denom
}

// fft is an in-place iterative radix-2 Cooley-Tukey FFT. len(re)==len(im) must be
// a power of two.
func fft(re, im []float64) {
	n := len(re)
	if n <= 1 {
		return
	}
	// Bit-reversal permutation.
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	for length := 2; length <= n; length <<= 1 {
		ang := -2 * math.Pi / float64(length)
		wlenRe := math.Cos(ang)
		wlenIm := math.Sin(ang)
		for i := 0; i < n; i += length {
			wRe, wIm := 1.0, 0.0
			for j := 0; j < length/2; j++ {
				uRe := re[i+j]
				uIm := im[i+j]
				vRe := re[i+j+length/2]*wRe - im[i+j+length/2]*wIm
				vIm := re[i+j+length/2]*wIm + im[i+j+length/2]*wRe
				re[i+j] = uRe + vRe
				im[i+j] = uIm + vIm
				re[i+j+length/2] = uRe - vRe
				im[i+j+length/2] = uIm - vIm
				wReNew := wRe*wlenRe - wIm*wlenIm
				wIm = wRe*wlenIm + wIm*wlenRe
				wRe = wReNew
			}
		}
	}
}
