// Command terminal is a 3270-style client for the customer information
// API. It runs in your local terminal and talks to the API over HTTP.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/sdf1jpf/terminal/internal/api"
	"github.com/sdf1jpf/terminal/internal/host"
	"github.com/sdf1jpf/terminal/internal/store"
	"github.com/sdf1jpf/terminal/internal/tn3270"
)

func main() {
	defaultURL := os.Getenv("TERMINAL_API_URL")
	if defaultURL == "" {
		defaultURL = "http://localhost:8080"
	}
	var (
		apiURL   = flag.String("api", defaultURL, "customer API base URL (or set TERMINAL_API_URL)")
		embedded = flag.Bool("embedded", false, "start a private in-memory API server inside this process")
		sysName  = flag.String("system", "SYS1", "system name shown on screens")
		lu       = flag.String("lu", "TERM0001", "terminal name shown in the status line")
		latency  = flag.Duration("latency", 0, "extra delay added to every host response, for effect")
	)
	flag.Parse()

	if *embedded {
		url, err := startEmbedded()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		*apiURL = url
	}

	sess := host.NewSession(&host.Config{
		SystemName: *sysName,
		Backend:    api.NewClient(*apiURL),
	}, *lu)
	term := tn3270.New(sess, tn3270.Options{LUName: *lu, Latency: *latency})
	p := tea.NewProgram(term, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// startEmbedded runs the API with demo data on a loopback port, for trying
// the client without a separate server.
func startEmbedded() (string, error) {
	st, err := store.Open("")
	if err != nil {
		return "", err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	log.SetOutput(io.Discard) // request logs would draw over the screen
	srv := &http.Server{
		Handler:           api.NewServer(st, map[string]string{"IBMUSER": "SYS1", "GUEST": "GUEST"}).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go srv.Serve(ln)
	return "http://" + ln.Addr().String(), nil
}
