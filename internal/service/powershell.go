package service

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/binary"
	"unicode/utf16"
)

// An encoded PowerShell command is UTF-16 base64. Compress the embedded source
// first so the complete task control program fits Windows' 32767-unit argv limit
// without writing executable scripts into the user's state or install directory.
func powerShellCommand(script string) (string, error) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte(script)); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	payload := base64.StdEncoding.EncodeToString(compressed.Bytes())
	bootstrap := `& ([scriptblock]::Create(([IO.StreamReader]::new([IO.Compression.GzipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('` + payload + `')),[IO.Compression.CompressionMode]::Decompress))).ReadToEnd()))`
	units := utf16.Encode([]rune(bootstrap))
	data := make([]byte, 2*len(units))
	for i, unit := range units {
		binary.LittleEndian.PutUint16(data[2*i:], unit)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}
