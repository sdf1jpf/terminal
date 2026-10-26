// Command terminal is a 3270-style client for the customer information
// API. It runs in your local terminal and talks to the API over HTTP.
package main

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/sdf1jpf/terminal/internal/api"
	"github.com/sdf1jpf/terminal/internal/host"
	"github.com/sdf1jpf/terminal/internal/tn3270"
)

func main() {
	defaultURL := os.Getenv("TERMINAL_API_URL")
	if defaultURL == "" {
		defaultURL = "http://localhost:8787" // wrangler dev
	}
	var (
		apiURL  = flag.String("api", defaultURL, "customer API base URL (or set TERMINAL_API_URL)")
		sysName = flag.String("system", "SYS1", "system name shown on screens")
		lu      = flag.String("lu", "TERM0001", "terminal name shown in the status line")
		latency = flag.Duration("latency", 0, "extra delay added to every host response, for effect")
		idle    = flag.Duration("idle", 30*time.Minute, "log off after this long without a key pressed (0 never)")
		prints  = flag.String("print-dir", defaultPrintDir(), "where the PRINT key (Ctrl+P) saves screens")
	)
	flag.Parse()

	sess := host.NewSession(&host.Config{
		SystemName: *sysName,
		Backend:    api.NewClient(*apiURL, access(*apiURL)),
	}, *lu)
	term := tn3270.New(sess, tn3270.Options{
		LUName: *lu, SystemName: *sysName, Latency: *latency, PrintDir: *prints, IdleTimeout: *idle,
	})
	p := tea.NewProgram(term, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// access picks how to get through Cloudflare Access: a service token from
// the environment, nothing for a local `wrangler dev`, or else a browser
// sign-in with cloudflared.
func access(apiURL string) api.Access {
	if id, secret := os.Getenv("CF_ACCESS_CLIENT_ID"), os.Getenv("CF_ACCESS_CLIENT_SECRET"); id != "" && secret != "" {
		return api.ServiceToken{ID: id, Secret: secret}
	}
	if u, err := url.Parse(apiURL); err == nil {
		switch u.Hostname() {
		case "localhost", "127.0.0.1", "::1":
			return nil
		}
	}
	return api.Cloudflared{App: apiURL}
}

// defaultPrintDir is ~/terminal-prints, or the current directory if there
// is no home directory.
func defaultPrintDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, "terminal-prints")
	}
	return "."
}
