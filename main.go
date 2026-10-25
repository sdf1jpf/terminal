// Command terminal runs a 3270-style customer information system, either
// in the local terminal or as an SSH server that users can log on to.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/ssh"
	"github.com/charmbracelet/wish"
	"github.com/charmbracelet/wish/activeterm"
	bm "github.com/charmbracelet/wish/bubbletea"
	"github.com/charmbracelet/wish/logging"

	"github.com/sdf1jpf/terminal/internal/host"
	"github.com/sdf1jpf/terminal/internal/store"
	"github.com/sdf1jpf/terminal/internal/tn3270"
)

func main() {
	var (
		sshAddr = flag.String("ssh", "", "serve over SSH on this address (e.g. :2323) instead of running locally")
		hostKey = flag.String("hostkey", ".ssh/terminal_ed25519", "SSH host key path (created if missing)")
		data    = flag.String("data", "", "persist customers to this JSON file (default: in memory)")
		sysName = flag.String("system", "SYS1", "system name shown on screens")
		latency = flag.Duration("latency", 150*time.Millisecond, "simulated host response time")
	)
	flag.Parse()

	st, err := store.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	cfg := &host.Config{
		SystemName: *sysName,
		Users:      map[string]string{"IBMUSER": "SYS1", "GUEST": "GUEST"},
		Store:      st,
	}

	if *sshAddr == "" {
		term := tn3270.New(host.NewSession(cfg, "TERM0001"), tn3270.Options{
			LUName:  "TERM0001",
			Latency: *latency,
		})
		p := tea.NewProgram(term, tea.WithAltScreen(), tea.WithMouseCellMotion())
		if _, err := p.Run(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	if err := serve(*sshAddr, *hostKey, cfg, *latency); err != nil {
		log.Fatal(err)
	}
}

func serve(addr, hostKey string, cfg *host.Config, latency time.Duration) error {
	var lus atomic.Int64
	handler := func(s ssh.Session) (tea.Model, []tea.ProgramOption) {
		lu := fmt.Sprintf("TERM%04d", lus.Add(1)%10000)
		term := tn3270.New(host.NewSession(cfg, lu), tn3270.Options{
			LUName:   lu,
			Latency:  latency,
			Renderer: bm.MakeRenderer(s),
		})
		return term, []tea.ProgramOption{tea.WithAltScreen(), tea.WithMouseCellMotion()}
	}

	srv, err := wish.NewServer(
		wish.WithAddress(addr),
		wish.WithHostKeyPath(hostKey),
		wish.WithMiddleware(
			bm.Middleware(handler),
			activeterm.Middleware(),
			logging.Middleware(),
		),
	)
	if err != nil {
		return err
	}

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	_, port, _ := net.SplitHostPort(addr)
	log.Printf("terminal listening on %s — connect with: ssh -p %s localhost", addr, port)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, ssh.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-done
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}
