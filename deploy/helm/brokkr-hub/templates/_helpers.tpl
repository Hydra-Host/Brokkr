{{- define "brokkr-hub.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "brokkr-hub.fullname" -}}
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

{{- define "brokkr-hub.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "brokkr-hub.labels" -}}
helm.sh/chart: {{ include "brokkr-hub.chart" . }}
app.kubernetes.io/name: {{ include "brokkr-hub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "brokkr-hub.selectorLabels" -}}
app.kubernetes.io/name: {{ include "brokkr-hub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "brokkr-hub.postgresHost" -}}
{{- printf "%s-postgres" (include "brokkr-hub.fullname" .) -}}
{{- end -}}

{{- define "brokkr-hub.redisHost" -}}
{{- printf "%s-redis" (include "brokkr-hub.fullname" .) -}}
{{- end -}}

{{/*
Credentials are URL-encoded so reserved characters (@ : / #) cannot break the
URI. urlquery is QueryEscape (space -> "+"), but userinfo needs %20; a literal
"+" is already escaped to %2B by then, so any remaining "+" is a space.
*/}}
{{- define "brokkr-hub.urlEncode" -}}
{{- . | urlquery | replace "+" "%20" -}}
{{- end -}}

{{- define "brokkr-hub.databaseUrl" -}}
{{- if .Values.secrets.DATABASE_URL -}}
{{- .Values.secrets.DATABASE_URL -}}
{{- else if .Values.postgres.enabled -}}
{{- printf "postgresql://%s:%s@%s:5432/%s" (include "brokkr-hub.urlEncode" .Values.postgres.auth.username) (include "brokkr-hub.urlEncode" .Values.postgres.auth.password) (include "brokkr-hub.postgresHost" .) (include "brokkr-hub.urlEncode" .Values.postgres.auth.database) -}}
{{- else -}}
{{- fail "secrets.DATABASE_URL is required when postgres.enabled=false" -}}
{{- end -}}
{{- end -}}

{{- define "brokkr-hub.redisUrl" -}}
{{- if .Values.secrets.REDIS_URL -}}
{{- .Values.secrets.REDIS_URL -}}
{{- else if .Values.redis.enabled -}}
{{- printf "redis://%s:6379" (include "brokkr-hub.redisHost" .) -}}
{{- else -}}
{{- fail "secrets.REDIS_URL is required when redis.enabled=false" -}}
{{- end -}}
{{- end -}}

{{- define "brokkr-hub.secretName" -}}
{{- default (include "brokkr-hub.fullname" .) .Values.secrets.existingSecret -}}
{{- end -}}
