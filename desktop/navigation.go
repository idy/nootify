package main

// pageLoadState distinguishes accepted navigation from a completed document.
// Asynchronous failures and gateway exit allow a fresh attempt on the next poll.
type pageLoadState struct{ online, loading bool }

func (s *pageLoadState) begin() bool {
	if s.online || s.loading {
		return false
	}
	s.loading = true
	return true
}
func (s *pageLoadState) finish(trusted bool) { s.loading = false; s.online = trusted }
func (s *pageLoadState) failed()             { s.loading = false; s.online = false }
