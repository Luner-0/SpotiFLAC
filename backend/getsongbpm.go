package backend

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Optional build-time default key. Leave empty for public builds — a committed
// key would be exposed and shared across all users. Each user should enter their
// own key in Settings instead.
const bundledGetSongBPMKey = ""

const getSongBPMAPIBase = "https://api.getsong.co"

// SongHarmonics holds the harmonic-mixing info for a track.
type SongHarmonics struct {
	BPM     int    `json:"bpm"`
	Key     string `json:"key"`
	Camelot string `json:"camelot"`
}

// GetGetSongBPMKey returns the configured GetSongBPM API key (user setting first,
// then the optional bundled default).
func GetGetSongBPMKey() string {
	settings, err := LoadConfigSettings()
	if err == nil && settings != nil {
		if key, ok := settings["getSongBpmApiKey"].(string); ok {
			if trimmed := strings.TrimSpace(key); trimmed != "" {
				return trimmed
			}
		}
	}
	return strings.TrimSpace(bundledGetSongBPMKey)
}

type getSongBPMArtist struct {
	Name string `json:"name"`
}

type getSongBPMSong struct {
	ID     string           `json:"id"`
	Title  string           `json:"song_title"`
	Tempo  string           `json:"tempo"`
	KeyOf  string           `json:"key_of"`
	Artist getSongBPMArtist `json:"artist"`
}

func getSongBPMHTTPGet(endpoint string) ([]byte, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "SpotiFLAC/"+AppVersion)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GetSongBPM returned status %d", resp.StatusCode)
	}
	return body, nil
}

// FetchSongHarmonics looks up tempo + key for a track via GetSongBPM and derives
// its Camelot code.
func FetchSongHarmonics(apiKey, artist, title string) (*SongHarmonics, error) {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return nil, fmt.Errorf("GetSongBPM API key is not set")
	}
	if strings.TrimSpace(title) == "" {
		return nil, fmt.Errorf("track title is required")
	}

	lookup := fmt.Sprintf("song:%s artist:%s", title, GetFirstArtist(artist))
	params := url.Values{}
	params.Set("api_key", apiKey)
	params.Set("type", "both")
	params.Set("lookup", lookup)
	searchURL := fmt.Sprintf("%s/search/?%s", getSongBPMAPIBase, params.Encode())

	body, err := getSongBPMHTTPGet(searchURL)
	if err != nil {
		return nil, err
	}

	// The "search" field is an array of results, or an object like
	// {"error":"no result"} when nothing matches.
	var envelope struct {
		Search json.RawMessage `json:"search"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("failed to parse GetSongBPM response: %w", err)
	}

	var results []getSongBPMSong
	if err := json.Unmarshal(envelope.Search, &results); err != nil || len(results) == 0 {
		return nil, fmt.Errorf("no harmonic data found for %q", title)
	}

	song := results[0]

	// Search results sometimes omit tempo/key; fetch the song detail if so.
	if (strings.TrimSpace(song.Tempo) == "" || strings.TrimSpace(song.KeyOf) == "") && song.ID != "" {
		if detail, derr := fetchSongBPMDetail(apiKey, song.ID); derr == nil && detail != nil {
			if strings.TrimSpace(song.Tempo) == "" {
				song.Tempo = detail.Tempo
			}
			if strings.TrimSpace(song.KeyOf) == "" {
				song.KeyOf = detail.KeyOf
			}
		}
	}

	harmonics := &SongHarmonics{
		Key:     strings.TrimSpace(song.KeyOf),
		Camelot: camelotFromKey(song.KeyOf),
	}
	if bpm, perr := strconv.Atoi(strings.TrimSpace(song.Tempo)); perr == nil {
		harmonics.BPM = bpm
	}

	if harmonics.BPM == 0 && harmonics.Key == "" {
		return nil, fmt.Errorf("no harmonic data found for %q", title)
	}
	return harmonics, nil
}

func fetchSongBPMDetail(apiKey, id string) (*getSongBPMSong, error) {
	params := url.Values{}
	params.Set("api_key", apiKey)
	params.Set("id", id)
	detailURL := fmt.Sprintf("%s/song/?%s", getSongBPMAPIBase, params.Encode())

	body, err := getSongBPMHTTPGet(detailURL)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Song getSongBPMSong `json:"song"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, err
	}
	return &envelope.Song, nil
}

// Camelot codes indexed by pitch class (C=0 .. B=11).
var majorCamelot = [12]string{"8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"}
var minorCamelot = [12]string{"5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"}

var noteToPitchClass = map[string]int{
	"C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "FB": 4,
	"E#": 5, "F": 5, "F#": 6, "GB": 6, "G": 7, "G#": 8, "AB": 8, "A": 9,
	"A#": 10, "BB": 10, "B": 11, "CB": 11, "B#": 0,
}

// camelotFromKey converts a key string such as "G", "Gm", "F#", "Bbm",
// "C minor" into its Camelot code (e.g. "9B", "6A").
func camelotFromKey(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "♯", "#")
	s = strings.ReplaceAll(s, "♭", "b")

	runes := []rune(s)
	letter := unicode.ToUpper(runes[0])
	if letter < 'A' || letter > 'G' {
		return ""
	}
	root := string(letter)
	idx := 1
	if idx < len(runes) && (runes[idx] == '#' || runes[idx] == 'b') {
		root += string(runes[idx])
		idx++
	}

	pitch, ok := noteToPitchClass[strings.ToUpper(root)]
	if !ok {
		return ""
	}

	rest := strings.ToLower(string(runes[idx:]))
	minor := false
	switch {
	case strings.Contains(rest, "maj"):
		minor = false
	case strings.Contains(rest, "min"), strings.Contains(rest, "m"):
		minor = true
	}

	if minor {
		return minorCamelot[pitch]
	}
	return majorCamelot[pitch]
}
