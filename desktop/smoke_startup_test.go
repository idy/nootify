package main

import "testing"

func TestSmokeStartupWaitsForIntendedOfflineDocument(t *testing.T) {
	s := &shell{smoke: true, offline: &offlineServer{URL: "http://127.0.0.1:43210/"}}
	if s.smokeOfflineLoaded() {
		t.Fatal("smoke started before native navigation completed")
	}
	for _, raw := range []string{"about:blank", "", "http://127.0.0.1:43211/", "http://127.0.0.1:43210/other", "http://untrusted.invalid/"} {
		s.markSmokeOfflineLoaded(raw)
		if s.smokeOfflineLoaded() {
			t.Fatalf("an unrelated document admitted startup evaluations: %q", raw)
		}
	}
	s.markSmokeOfflineLoaded(s.offline.URL)
	if !s.smokeOfflineLoaded() {
		t.Fatal("native completion of the offline document did not admit assertions")
	}
	// Completion may precede startup of the smoke goroutine; readiness is latched.
	s.markSmokeOfflineLoaded("about:blank")
	if !s.smokeOfflineLoaded() {
		t.Fatal("completed offline navigation was lost")
	}
}

func TestProductionDoesNotRecordSmokeReadiness(t *testing.T) {
	s := &shell{offline: &offlineServer{URL: "http://127.0.0.1:43210/"}}
	s.markSmokeOfflineLoaded(s.offline.URL)
	if s.smokeOfflineLoaded() {
		t.Fatal("production shell retained smoke readiness")
	}
}
