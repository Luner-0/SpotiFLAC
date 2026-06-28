package backend

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// Accuracy harness for the in-app analyzer. Provide a CSV of labeled tracks and
// run:
//
//	SPOTIFLAC_EVAL_CSV=/path/to/labels.csv go test ./backend/ -run TestAnalyzerAccuracy -v
//
// CSV columns (header optional, '#' lines ignored):
//
//	filepath,key,bpm
//
// where `key` is either a musical key ("Am", "F#m", "C") or a Camelot code
// ("8A"), and `bpm` is the known tempo. It reports exact-key, harmonically-
// compatible-key, and BPM (incl. half/double) accuracy so we can tune the DSP.
func TestAnalyzerAccuracy(t *testing.T) {
	csvPath := os.Getenv("SPOTIFLAC_EVAL_CSV")
	if csvPath == "" {
		t.Skip("set SPOTIFLAC_EVAL_CSV to a labels CSV to run the analyzer accuracy harness")
	}
	rows, err := readEvalCSV(csvPath)
	if err != nil {
		t.Fatalf("read CSV: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("no rows in CSV")
	}

	var total, keyExact, keyCompat, bpmExact, bpmOctave int
	for _, row := range rows {
		res, err := AnalyzeAudioFile(row.path)
		if err != nil {
			t.Logf("FAIL  %-50s  error: %v", short(row.path), err)
			total++
			continue
		}
		total++

		gotCam := res.Camelot
		wantCam := toCamelot(row.key)
		exact := gotCam == wantCam
		compat := exact || camelotCompatible(gotCam, wantCam)
		if exact {
			keyExact++
		}
		if compat {
			keyCompat++
		}

		bpmOK := row.bpm > 0 && math.Abs(float64(res.BPM)-row.bpm) <= 2
		bpmOct := bpmOK ||
			(row.bpm > 0 && (math.Abs(float64(res.BPM)-row.bpm*2) <= 3 || math.Abs(float64(res.BPM)-row.bpm/2) <= 3))
		if bpmOK {
			bpmExact++
		}
		if bpmOct {
			bpmOctave++
		}

		mark := func(ok bool) string {
			if ok {
				return "ok "
			}
			return "MISS"
		}
		t.Logf("%-50s key %s got=%-3s want=%-3s | %s bpm got=%-3d want=%-3.0f conf=%.2f",
			short(row.path), mark(compat), gotCam, wantCam, mark(bpmOct), res.BPM, row.bpm, res.Confidence)
	}

	pct := func(n int) float64 { return 100 * float64(n) / float64(total) }
	t.Logf("==== ANALYZER ACCURACY (%d tracks) ====", total)
	t.Logf("key exact:        %d/%d  (%.0f%%)", keyExact, total, pct(keyExact))
	t.Logf("key compatible:   %d/%d  (%.0f%%)", keyCompat, total, pct(keyCompat))
	t.Logf("bpm exact (±2):   %d/%d  (%.0f%%)", bpmExact, total, pct(bpmExact))
	t.Logf("bpm incl octave:  %d/%d  (%.0f%%)", bpmOctave, total, pct(bpmOctave))
}

type evalRow struct {
	path string
	key  string
	bpm  float64
}

func readEvalCSV(path string) ([]evalRow, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var rows []evalRow
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 2 {
			continue
		}
		// Parse from the right so a comma inside the file path is preserved:
		// last field = bpm, second-last = key, everything before = path.
		var row evalRow
		if len(parts) >= 3 {
			row.bpm, _ = strconv.ParseFloat(strings.TrimSpace(parts[len(parts)-1]), 64)
			row.key = strings.TrimSpace(parts[len(parts)-2])
			row.path = strings.TrimSpace(strings.Join(parts[:len(parts)-2], ","))
		} else {
			row.path = strings.TrimSpace(parts[0])
			row.key = strings.TrimSpace(parts[1])
		}
		if strings.EqualFold(row.path, "filepath") || strings.EqualFold(row.path, "path") {
			continue // header
		}
		rows = append(rows, row)
	}
	return rows, sc.Err()
}

var camelotRe = regexp.MustCompile(`^(\d{1,2})([ABab])$`)

func toCamelot(label string) string {
	s := strings.TrimSpace(label)
	if m := camelotRe.FindStringSubmatch(s); m != nil {
		return m[1] + strings.ToUpper(m[2])
	}
	return camelotFromKey(s)
}

// camelotCompatible reports whether two Camelot codes are a classic smooth move:
// same code, relative major/minor (same number), or ±1 on the wheel.
func camelotCompatible(a, b string) bool {
	am := camelotRe.FindStringSubmatch(a)
	bm := camelotRe.FindStringSubmatch(b)
	if am == nil || bm == nil {
		return false
	}
	an, _ := strconv.Atoi(am[1])
	bn, _ := strconv.Atoi(bm[1])
	al := strings.ToUpper(am[2])
	bl := strings.ToUpper(bm[2])
	if an == bn {
		return true // same or relative
	}
	if al == bl {
		d := (an - bn + 12) % 12
		if d == 1 || d == 11 {
			return true
		}
	}
	return false
}

func short(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		p = p[i+1:]
	}
	if len(p) > 50 {
		p = p[:47] + "..."
	}
	return fmt.Sprintf("%-50s", p)
}
