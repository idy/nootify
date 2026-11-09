package main

import "testing"

func TestNavigationRetriesOnlyAfterCompletionOrFailure(t *testing.T) {
	var state pageLoadState
	if !state.begin() || state.online || !state.loading {
		t.Fatal("initiated load was treated as online")
	}
	if state.begin() {
		t.Fatal("duplicate navigation while loading")
	}
	state.failed() // asynchronous LoadURL failure, even though initiation succeeded
	if !state.begin() {
		t.Fatal("load failure prevented retry")
	}
	state.finish(true)
	if !state.online || state.loading || state.begin() {
		t.Fatal("completed gateway page did not establish online")
	}
	state.finish(false) // unexpected navigation/offline fallback
	if state.online || !state.begin() {
		t.Fatal("fallback left the established view stuck online")
	}
	state.failed() // owned gateway exited or idle expiration closed it
	if !state.begin() {
		t.Fatal("owned gateway exit prevented reauthorization")
	}
}

func TestNativeDocumentsRequireExplicitOwnedGateway(t *testing.T) {
	policy := urlPolicy{offline: "http://127.0.0.1:18001/", gateway: "http://127.0.0.1:18002/"}
	if !policy.allowed(policy.gateway) || policy.allowed("http://127.0.0.1:9417/") || policy.allowed("http://127.0.0.1:18003/") {
		t.Fatal("service or unrelated local origin admitted")
	}
	s := shell{policy: policy}
	if s.trustedDocument(policy.gateway) {
		t.Fatal("an origin without a live owned gateway authorized native actions")
	}
	if !s.trustedDocument(policy.offline) {
		t.Fatal("bundled offline page denied")
	}
}
