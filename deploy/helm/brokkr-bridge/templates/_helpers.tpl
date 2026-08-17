{{- define "brokkr-bridge.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "brokkr-bridge.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "brokkr-bridge.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "brokkr-bridge.labels" -}}
helm.sh/chart: {{ include "brokkr-bridge.chart" . }}
app.kubernetes.io/name: {{ include "brokkr-bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "brokkr-bridge.selectorLabels" -}}
app.kubernetes.io/name: {{ include "brokkr-bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "brokkr-bridge.zoneId" -}}
{{- required "config.BROKKR_ZONE_ID is required - the Zone UUID from the hub" .Values.config.BROKKR_ZONE_ID -}}
{{- end -}}

{{- define "brokkr-bridge.secretName" -}}
{{- default (include "brokkr-bridge.fullname" .) .Values.secrets.existingSecret -}}
{{- end -}}

{{/*
Plain env for the ConfigMap: .Values.env plus the keys derived from the
`config:` contract knobs, which win over same-named env entries.
*/}}
{{- define "brokkr-bridge.env" -}}
{{- $derived := dict
  "PORT" (toString .Values.config.BRIDGE_PORT)
  "BRIDGE_URL" .Values.config.BRIDGE_URL
  "BRIDGE_SYNC_ENABLED" (toString .Values.config.BRIDGE_SYNC_ENABLED)
  "BROKKR_ZONE_ID" (include "brokkr-bridge.zoneId" .)
  "REDIS_PREFIX" (include "brokkr-bridge.zoneId" .)
-}}
{{- range $key, $value := merge $derived (deepCopy .Values.env) }}
{{ $key }}: {{ $value | toString | quote }}
{{- end }}
{{- end -}}
