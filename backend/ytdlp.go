package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// yt-dlp powers URL-based downloads (SoundCloud, YouTube, Bandcamp, …). The
// single self-contained binary is fetched on demand into ~/.spotiflac, mirroring
// how ffmpeg is managed, and uses the already-managed ffmpeg for extraction.
//
// We pull the "latest" release asset so the extractors stay current (yt-dlp's
// site extractors break often and require updates); asset names are stable.
const ytDlpReleaseBase = "https://github.com/yt-dlp/yt-dlp/releases/latest/download"

func ytDlpAssetName() (string, error) {
	switch runtime.GOOS {
	case "windows":
		return "yt-dlp.exe", nil
	case "linux":
		return "yt-dlp_linux", nil
	case "darwin":
		return "yt-dlp_macos", nil
	default:
		return "", fmt.Errorf("unsupported operating system: %s", runtime.GOOS)
	}
}

func GetYtDlpPath() (string, error) {
	dir, err := EnsureAppDir()
	if err != nil {
		return "", err
	}
	name := "yt-dlp"
	if runtime.GOOS == "windows" {
		name = "yt-dlp.exe"
	}
	return filepath.Join(dir, name), nil
}

func IsYtDlpInstalled() bool {
	path, err := GetYtDlpPath()
	if err != nil {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Size() > 0
}

func DownloadYtDlp(progressCallback func(int)) error {
	asset, err := ytDlpAssetName()
	if err != nil {
		return err
	}
	dest, err := GetYtDlpPath()
	if err != nil {
		return err
	}

	SetDownloading(true)
	SetDownloadProgress(0)
	SetDownloadSpeed(0)
	defer SetDownloading(false)

	url := ytDlpReleaseBase + "/" + asset
	if err := downloadBinaryWithProgress(url, dest, progressCallback); err != nil {
		return err
	}
	return prepareExecutableForUse(dest)
}

func downloadBinaryWithProgress(url, dest string, progressCallback func(int)) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to download yt-dlp: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download yt-dlp: HTTP %d", resp.StatusCode)
	}

	tmp := dest + ".part"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}

	total := resp.ContentLength
	var downloaded int64
	lastTime := time.Now()
	var lastBytes int64
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				out.Close()
				os.Remove(tmp)
				return werr
			}
			downloaded += int64(n)
			SetDownloadProgress(float64(downloaded) / (1024 * 1024))
			now := time.Now()
			if diff := now.Sub(lastTime).Seconds(); diff > 0.1 {
				SetDownloadSpeed((float64(downloaded-lastBytes) / (1024 * 1024)) / diff)
				lastTime = now
				lastBytes = downloaded
			}
			if total > 0 && progressCallback != nil {
				progressCallback(int(float64(downloaded) / float64(total) * 100))
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			out.Close()
			os.Remove(tmp)
			return readErr
		}
	}
	out.Close()

	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return err
	}
	if progressCallback != nil {
		progressCallback(100)
	}
	return nil
}

// ExternalMedia is the subset of yt-dlp's JSON metadata we surface.
type ExternalMedia struct {
	Title      string `json:"title"`
	Uploader   string `json:"uploader"`
	Duration   int    `json:"duration"` // seconds
	Thumbnail  string `json:"thumbnail"`
	WebpageURL string `json:"webpage_url"`
	Extractor  string `json:"extractor_key"`
}

func ResolveMedia(url string) (*ExternalMedia, error) {
	if strings.TrimSpace(url) == "" {
		return nil, fmt.Errorf("url is required")
	}
	bin, err := GetYtDlpPath()
	if err != nil {
		return nil, err
	}
	if !IsYtDlpInstalled() {
		return nil, fmt.Errorf("yt-dlp is not installed")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-J", "--no-playlist", "--skip-download", "--no-warnings", url)
	setHideWindow(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("yt-dlp could not read that link: %s", strings.TrimSpace(stderr.String()))
	}

	var media ExternalMedia
	if err := json.Unmarshal(stdout.Bytes(), &media); err != nil {
		return nil, fmt.Errorf("failed to parse media info: %w", err)
	}
	if strings.TrimSpace(media.Title) == "" {
		return nil, fmt.Errorf("no media found at that URL")
	}
	if strings.TrimSpace(media.WebpageURL) == "" {
		media.WebpageURL = url
	}
	return &media, nil
}

func normalizeExternalAudioFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "opus":
		return "opus"
	case "best":
		return "best"
	default:
		return "mp3"
	}
}

// DownloadMedia extracts audio from a URL into outputDir. filenameNoExt is the
// desired base name (without extension); when empty, yt-dlp's title is used.
// Returns the path to the produced audio file.
func DownloadMedia(url, outputDir, filenameNoExt, audioFormat string) (string, error) {
	if strings.TrimSpace(url) == "" {
		return "", fmt.Errorf("url is required")
	}
	bin, err := GetYtDlpPath()
	if err != nil {
		return "", err
	}
	if !IsYtDlpInstalled() {
		return "", fmt.Errorf("yt-dlp is not installed")
	}

	outputDir = NormalizePath(SanitizeFolderPath(outputDir))
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return "", err
	}

	format := normalizeExternalAudioFormat(audioFormat)
	base := SanitizeFilename(filenameNoExt)
	if strings.TrimSpace(filenameNoExt) == "" {
		base = "%(title)s"
	}
	outTemplate := filepath.Join(outputDir, base+".%(ext)s")

	args := []string{
		"-x",
		"--audio-format", format,
		"--audio-quality", "0",
		"--no-playlist",
		"--no-warnings",
		"--add-metadata",
		"-o", outTemplate,
	}
	if ffmpegDir, derr := GetFFmpegDir(); derr == nil && ffmpegDir != "" {
		args = append(args, "--ffmpeg-location", ffmpegDir)
	}
	args = append(args, url)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	setHideWindow(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("yt-dlp download failed: %s", strings.TrimSpace(stderr.String()))
	}

	// Locate the produced file.
	if format != "best" && base != "%(title)s" {
		candidate := filepath.Join(outputDir, base+"."+format)
		if info, serr := os.Stat(candidate); serr == nil && info.Size() > 0 {
			return candidate, nil
		}
	}
	pattern := filepath.Join(outputDir, base+".*")
	if base == "%(title)s" {
		pattern = filepath.Join(outputDir, "*")
	}
	matches, _ := filepath.Glob(pattern)
	var newest string
	var newestMod time.Time
	for _, m := range matches {
		info, serr := os.Stat(m)
		if serr != nil || info.Size() == 0 || info.IsDir() {
			continue
		}
		if info.ModTime().After(newestMod) {
			newestMod = info.ModTime()
			newest = m
		}
	}
	if newest != "" {
		return newest, nil
	}
	return "", fmt.Errorf("download finished but output file was not found")
}
