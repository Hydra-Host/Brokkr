{{- /*
  Renders the hub env verbatim from the Nomad Variable at NOMAD_META_env_var_path.
  Every key in the Variable is emitted - the contract requires each key PRESENT
  (empty is fine), so populate the Variable from the full hub.env.example.
*/ -}}
{{- with nomadVar (env "NOMAD_META_env_var_path") -}}
{{- range $k, $v := . }}
{{ $k }}={{ $v }}
{{- end }}
{{- end -}}
