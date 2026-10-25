// Package store holds the customer master file used by the sample
// application. It is in memory, safe for concurrent sessions, and can be
// persisted to a JSON file.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type Customer struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Address string    `json:"address"`
	City    string    `json:"city"`
	State   string    `json:"state"`
	Zip     string    `json:"zip"`
	Phone   string    `json:"phone"`
	Limit   int       `json:"credit_limit"`
	Balance int       `json:"balance"`
	Status  string    `json:"status"` // A=active, H=hold, C=closed
	Updated time.Time `json:"updated"`
	By      string    `json:"updated_by"`
}

var ErrNotFound = errors.New("record not found")

type Store struct {
	mu   sync.RWMutex
	recs map[string]Customer
	path string
	next int
}

// Open loads path if it exists, otherwise seeds sample data. An empty path
// keeps everything in memory.
func Open(path string) (*Store, error) {
	s := &Store{recs: map[string]Customer{}, path: path}
	if path != "" {
		data, err := os.ReadFile(path)
		switch {
		case err == nil:
			var list []Customer
			if err := json.Unmarshal(data, &list); err != nil {
				return nil, fmt.Errorf("read %s: %w", path, err)
			}
			for _, c := range list {
				s.recs[c.ID] = c
			}
		case !errors.Is(err, os.ErrNotExist):
			return nil, err
		}
	}
	if len(s.recs) == 0 {
		for _, c := range seed {
			c.Updated = time.Date(1987, 3, 14, 9, 30, 0, 0, time.UTC)
			c.By = "IBMUSER"
			s.recs[c.ID] = c
		}
	}
	for id := range s.recs {
		var n int
		fmt.Sscanf(id, "%d", &n)
		s.next = max(s.next, n)
	}
	return s, nil
}

// List returns customers whose name begins with prefix, ordered by name.
func (s *Store) List(prefix string) []Customer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	prefix = strings.ToUpper(prefix)
	var out []Customer
	for _, c := range s.recs {
		if strings.HasPrefix(c.Name, prefix) {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (s *Store) Get(id string) (Customer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.recs[id]
	if !ok {
		return Customer{}, ErrNotFound
	}
	return c, nil
}

// Put inserts or replaces a customer. A blank ID is assigned the next
// number.
func (s *Store) Put(c Customer, user string) (Customer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.ID == "" {
		s.next++
		c.ID = fmt.Sprintf("%06d", s.next)
	}
	c.Updated = time.Now().UTC()
	c.By = user
	s.recs[c.ID] = c
	return c, s.save()
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.recs[id]; !ok {
		return ErrNotFound
	}
	delete(s.recs, id)
	return s.save()
}

func (s *Store) save() error {
	if s.path == "" {
		return nil
	}
	list := make([]Customer, 0, len(s.recs))
	for _, c := range s.recs {
		list = append(list, c)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

var seed = []Customer{
	{ID: "000101", Name: "ACME TOOL & DIE", Address: "1200 INDUSTRIAL PKWY", City: "DAYTON", State: "OH", Zip: "45402", Phone: "937-555-0101", Limit: 50000, Balance: 12450, Status: "A"},
	{ID: "000102", Name: "BLUE RIDGE MILLING", Address: "44 RIVER RD", City: "ROANOKE", State: "VA", Zip: "24011", Phone: "540-555-0177", Limit: 25000, Balance: 3020, Status: "A"},
	{ID: "000103", Name: "CONSOLIDATED FREIGHT", Address: "9 TERMINAL WAY", City: "MEMPHIS", State: "TN", Zip: "38103", Phone: "901-555-0133", Limit: 100000, Balance: 87211, Status: "H"},
	{ID: "000104", Name: "DELTA MARINE SUPPLY", Address: "310 HARBOR DR", City: "MOBILE", State: "AL", Zip: "36602", Phone: "251-555-0190", Limit: 15000, Balance: 0, Status: "A"},
	{ID: "000105", Name: "EVERGREEN TIMBER CO", Address: "77 LOGGERS LN", City: "EUGENE", State: "OR", Zip: "97401", Phone: "541-555-0122", Limit: 40000, Balance: 15600, Status: "A"},
	{ID: "000106", Name: "FIRST NATIONAL GRAIN", Address: "1 ELEVATOR SQ", City: "TOPEKA", State: "KS", Zip: "66603", Phone: "785-555-0108", Limit: 75000, Balance: 70250, Status: "A"},
	{ID: "000107", Name: "GRANITE STATE BEARING", Address: "52 MILL ST", City: "NASHUA", State: "NH", Zip: "03060", Phone: "603-555-0145", Limit: 20000, Balance: 1800, Status: "A"},
	{ID: "000108", Name: "HUDSON VALLEY DAIRY", Address: "880 FARM RD 9", City: "KINGSTON", State: "NY", Zip: "12401", Phone: "845-555-0161", Limit: 10000, Balance: 9990, Status: "H"},
	{ID: "000109", Name: "IRONWORKS FABRICATION", Address: "16 FORGE AVE", City: "GARY", State: "IN", Zip: "46402", Phone: "219-555-0119", Limit: 60000, Balance: 22000, Status: "A"},
	{ID: "000110", Name: "JUNIPER SOFTWARE LABS", Address: "2400 CAMPUS DR", City: "AUSTIN", State: "TX", Zip: "78701", Phone: "512-555-0184", Limit: 30000, Balance: 4100, Status: "A"},
	{ID: "000111", Name: "KEYSTONE STEEL", Address: "500 FURNACE ST", City: "BETHLEHEM", State: "PA", Zip: "18015", Phone: "610-555-0112", Limit: 120000, Balance: 64300, Status: "A"},
	{ID: "000112", Name: "LAKESHORE PAPER", Address: "8 PULP MILL RD", City: "GREEN BAY", State: "WI", Zip: "54301", Phone: "920-555-0156", Limit: 35000, Balance: 0, Status: "C"},
	{ID: "000113", Name: "MIDWEST AGRI CORP", Address: "1450 COUNTY RD 12", City: "AMES", State: "IA", Zip: "50010", Phone: "515-555-0139", Limit: 45000, Balance: 18750, Status: "A"},
	{ID: "000114", Name: "NORTHSTAR AVIONICS", Address: "3 HANGAR BLVD", City: "WICHITA", State: "KS", Zip: "67202", Phone: "316-555-0171", Limit: 90000, Balance: 31200, Status: "A"},
	{ID: "000115", Name: "OCEANIC CANNERY", Address: "120 WHARF ST", City: "ASTORIA", State: "OR", Zip: "97103", Phone: "503-555-0128", Limit: 12000, Balance: 11000, Status: "A"},
	{ID: "000116", Name: "PIEDMONT TEXTILES", Address: "61 LOOM CT", City: "GREENSBORO", State: "NC", Zip: "27401", Phone: "336-555-0193", Limit: 28000, Balance: 7300, Status: "A"},
	{ID: "000117", Name: "QUARRY ROCK & GRAVEL", Address: "RT 4 BOX 18", City: "BARRE", State: "VT", Zip: "05641", Phone: "802-555-0107", Limit: 18000, Balance: 2500, Status: "A"},
	{ID: "000118", Name: "REDWOOD ELECTRIC", Address: "700 VOLTAGE AVE", City: "FRESNO", State: "CA", Zip: "93721", Phone: "559-555-0150", Limit: 55000, Balance: 40200, Status: "H"},
	{ID: "000119", Name: "SUNBELT CITRUS", Address: "15 GROVE RD", City: "LAKELAND", State: "FL", Zip: "33801", Phone: "863-555-0166", Limit: 22000, Balance: 600, Status: "A"},
	{ID: "000120", Name: "TRI-STATE TRUCKING", Address: "2 DEPOT PL", City: "CAIRO", State: "IL", Zip: "62914", Phone: "618-555-0124", Limit: 65000, Balance: 51000, Status: "A"},
	{ID: "000121", Name: "UNITED BOLT & NUT", Address: "93 THREAD ST", City: "ROCKFORD", State: "IL", Zip: "61101", Phone: "815-555-0187", Limit: 16000, Balance: 4200, Status: "A"},
	{ID: "000122", Name: "VALLEY FORGE PRINTING", Address: "40 PRESS AVE", City: "NORRISTOWN", State: "PA", Zip: "19401", Phone: "484-555-0115", Limit: 14000, Balance: 13900, Status: "A"},
	{ID: "000123", Name: "WESTERN PLAINS ENERGY", Address: "1 DERRICK DR", City: "CASPER", State: "WY", Zip: "82601", Phone: "307-555-0142", Limit: 150000, Balance: 98000, Status: "A"},
	{ID: "000124", Name: "YANKEE CLIPPER SHIPYARD", Address: "PIER 7", City: "BATH", State: "ME", Zip: "04530", Phone: "207-555-0179", Limit: 80000, Balance: 26600, Status: "A"},
}
