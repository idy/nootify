package providers

import (
	"math"
	"os"
)

// legacyMigration reads existing SQLite rows as data. Historical cursor import
// is a one-time handoff to the core; it never starts the retired legacy poller.
func (s *Service) legacyMigration(initial Credentials) (map[string]any, error) {
	migration := initial
	savedID, savedSecret := s.options.Store.Setting("lark_app_id"), s.options.Store.Setting("lark_app_secret")
	if savedID != "" && savedSecret != "" {
		migration.AppID, migration.AppSecret = savedID, savedSecret
		migration.Recipient = s.options.Store.Setting("lark_recipient_open_id")
		if migration.Recipient == "" && savedID == initial.AppID {
			migration.Recipient = initial.Recipient
		}
	}
	if migration.AppID == "" || migration.AppSecret == "" {
		return nil, nil
	}
	rows, e := s.options.Store.Rows("lark_bindings")
	if e != nil {
		return nil, e
	}
	observations, e := s.options.Store.Rows("session_observations")
	if e != nil {
		return nil, e
	}
	cursors, e := s.options.Store.Rows("lark_poll_cursors")
	if e != nil {
		return nil, e
	}
	observed := map[string]map[string]bool{}
	for _, row := range observations {
		v := asMap(row.Value)
		id, adapter := str(v["session_id"]), str(v["adapter"])
		if id != "" && ValidAdapter(adapter) {
			if observed[id] == nil {
				observed[id] = map[string]bool{}
			}
			observed[id][adapter] = true
		}
	}
	boundaries := map[string]int64{}
	for _, row := range cursors {
		v := asMap(row.Value)
		chat := str(v["chat_id"])
		if v["app_id"] != migration.AppID || v["container_type"] != "chat" || v["container_id"] != chat || chat == "" {
			continue
		}
		through, ok := v["through"].(float64)
		if !ok || through <= 0 || math.Trunc(through) != through || through > 9007199254740991 {
			continue
		}
		if int64(through) > boundaries[chat] {
			boundaries[chat] = int64(through)
		}
	}
	bindings := []map[string]any{}
	senders := map[string]bool{}
	for _, row := range rows {
		binding := asMap(row.Value)
		id := str(binding["session_id"])
		var registered map[string]any
		_, e = s.options.Store.Get("sessions", id, &registered)
		if e != nil {
			return nil, e
		}
		if str(binding["adapter"]) == "" {
			if adapter := str(registered["adapter"]); adapter != "" {
				binding["adapter"] = adapter
			} else if choices := observed[id]; len(choices) == 1 {
				for adapter := range choices {
					binding["adapter"] = adapter
				}
			}
		}
		if binding["session_name"] == nil && registered["session_name"] != nil {
			binding["session_name"] = registered["session_name"]
		}
		app := first(str(binding["app_id"]), migration.AppID)
		if app == migration.AppID {
			if cursor := boundaries[str(binding["chat_id"])]; cursor > 0 {
				binding["history_cursor"] = cursor
			}
			if sender := str(binding["sender_open_id"]); sender != "" {
				senders[sender] = true
			}
		}
		bindings = append(bindings, binding)
	}
	if migration.Recipient == "" && len(senders) == 1 {
		for sender := range senders {
			migration.Recipient = sender
		}
	}
	host, _ := os.Hostname()
	result := map[string]any{"app_id": migration.AppID, "app_secret": migration.AppSecret, "recipient_open_id": migration.Recipient, "legacy_host": host, "bindings": bindings}
	if kind := s.options.Store.Setting("lark_connection_type"); savedID == migration.AppID && (kind == "bot" || kind == "personal-app") {
		result["connection_type"] = kind
	}
	return result, nil
}
func (s *Service) startupCompatibilityWarning(err error) bool {
	switch errorCode(err) {
	case "committed_not_durable", "committed_not_mirrored":
		s.report(map[string]any{"status": "startup_" + errorCode(err)})
		return true
	}
	return false
}
