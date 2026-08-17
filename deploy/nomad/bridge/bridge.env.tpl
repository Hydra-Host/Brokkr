{{- /*
  Renders the bridge env verbatim from the Nomad Variable at
  NOMAD_META_env_var_path, deriving REDIS_PREFIX from BROKKR_ZONE_ID.
*/ -}}
{{- with nomadVar (env "NOMAD_META_env_var_path") -}}
{{- range $k, $v := . }}
{{ $k }}={{ $v }}
{{- end }}
REDIS_PREFIX={{ .BROKKR_ZONE_ID }}
{{- end -}}
