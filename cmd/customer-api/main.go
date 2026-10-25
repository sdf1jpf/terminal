// Command customer-api serves the customer information REST API that the
// terminal client talks to.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/sdf1jpf/terminal/internal/api"
	"github.com/sdf1jpf/terminal/internal/store"
)

func main() {
	addr := flag.String("addr", "localhost:8080", "listen address")
	data := flag.String("data", "", "persist customers to this JSON file (default: in memory)")
	flag.Parse()

	st, err := store.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	users, err := parseUsers(os.Getenv("CUSTAPI_USERS"))
	if err != nil {
		log.Fatal(err)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           api.NewServer(st, users).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Printf("customer API listening on http://%s", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

// parseUsers reads "USER:PASSWORD,USER2:PASSWORD2". Empty means the demo
// users.
func parseUsers(spec string) (map[string]string, error) {
	if spec == "" {
		return map[string]string{"IBMUSER": "SYS1", "GUEST": "GUEST"}, nil
	}
	users := map[string]string{}
	for _, pair := range strings.Split(spec, ",") {
		u, p, ok := strings.Cut(strings.TrimSpace(pair), ":")
		if !ok || u == "" || p == "" {
			return nil, errors.New("CUSTAPI_USERS must look like USER:PASSWORD,USER2:PASSWORD2")
		}
		users[strings.ToUpper(u)] = strings.ToUpper(p)
	}
	return users, nil
}
