# Local observability sink — native processes only (no docker). The OTel collector
# receives OTLP from the hub/spokes (tracing turns on when
# OTEL_EXPORTER_OTLP_ENDPOINT is set — injected in modules/hub.nix and
# modules/spoke.nix when telemetry.enable), forwards traces to Tempo (whose
# metrics-generator remote-writes span-metrics to the EXISTING Thanos receive),
# app metrics to Thanos, and logs to Loki (native OTLP ingest); Grafana serves
# the repo dashboards (packages/telemetry/dashboards) over datasources pinned to the
# uids they hardcode: "prometheus" (thanos-query), "tempo", and "loki". Gated on
# telemetry.enable (declared in overrides.nix, default false): processes stay
# defined-but-disabled (fleet.autoStart precedent) — an on-demand start brings up
# the SINK only; the hub exports nothing until telemetry.enable=true re-renders
# its env (eval-time, modules/hub.nix) and hub-api restarts. No other process
# depends on them (an unsatisfiable dep on a disabled process would stall the
# graph — see fleet.nix). Everything binds loopback regardless of lan.expose:
# grafana runs with anonymous-Admin auth and must never face the LAN.
{
  pkgs,
  lib,
  config,
  ...
}:
let
  P = (import ./ports.nix).fromConfig config;
  localStack = !config.remoteInfra.enable;
  enabled = config.telemetry.enable;
  inherit (P.hosts) loopback;

  # Dashboards live in the HUB checkout — resolve through the polyrepo seam
  # (same derivation as devenv.nix's HUB_REPO_PATH; a runtime
  # stackOverrides.hub.HUB_REPO_PATH override can't be captured at eval time).
  expandHome = (import ./lib.nix).expandHome lib (builtins.getEnv "HOME");
  hubRepo =
    if config.polyrepo.hub.path == "" then
      config.env.DEVENV_ROOT
    else
      expandHome config.polyrepo.hub.path;

  otelcolConfig = pkgs.writeText "otelcol.yaml" ''
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: ${loopback}:${toString P.ports.otlpGrpc}
          http:
            endpoint: ${loopback}:${toString P.ports.otlpHttp}
    exporters:
      otlp/tempo:
        endpoint: ${loopback}:${toString P.ports.tempoOtlpGrpc}
        tls:
          insecure: true
      prometheusremotewrite/thanos:
        endpoint: http://${loopback}:${toString P.ports.thanosRemoteWrite}/api/v1/receive
      otlphttp/loki:
        # loki 3.x ingests OTLP natively; /otlp is its ingest prefix (the
        # exporter appends /v1/logs itself)
        endpoint: http://${loopback}:${toString P.ports.lokiHttp}/otlp
      debug:
        verbosity: basic
    extensions:
      health_check:
        endpoint: ${loopback}:${toString P.ports.otelcolHealth}
    service:
      extensions: [health_check]
      telemetry:
        metrics:
          level: none # the default pull reader would bind :8888 — nginx owns that port
      pipelines:
        traces:
          receivers: [otlp]
          exporters: [otlp/tempo]
        metrics:
          receivers: [otlp]
          # debug alongside: nothing sends OTLP metrics until phase 4, so any
          # batch showing up in the collector log is unexpected traffic
          exporters: [prometheusremotewrite/thanos, debug]
        logs:
          receivers: [otlp]
          exporters: [otlphttp/loki]
  '';

  lokiConfig = pkgs.writeText "loki.yaml" ''
    auth_enabled: false
    server:
      http_listen_address: ${loopback}
      http_listen_port: ${toString P.ports.lokiHttp}
      # No client dials it, but Loki opens its gRPC listener regardless of
      # deployment mode — pin it to loopback + a declared port rather than
      # inherit the 0.0.0.0:9095 default.
      grpc_listen_address: ${loopback}
      grpc_listen_port: ${toString P.ports.lokiGrpc}
    common:
      instance_addr: ${loopback}
      path_prefix: ${config.env.DEVENV_STATE}/loki
      storage:
        filesystem:
          chunks_directory: ${config.env.DEVENV_STATE}/loki/chunks
          rules_directory: ${config.env.DEVENV_STATE}/loki/rules
      replication_factor: 1
      ring:
        kvstore:
          store: inmemory
    schema_config:
      configs:
        - from: 2024-01-01
          store: tsdb
          object_store: filesystem
          schema: v13
          index:
            prefix: index_
            period: 24h
    compactor:
      working_directory: ${config.env.DEVENV_STATE}/loki/compactor
      retention_enabled: true
      delete_request_store: filesystem
    limits_config:
      retention_period: 24h # match tempo's block_retention
      # OTLP-ingested attributes land as structured metadata (v13 schema requirement)
      allow_structured_metadata: true
    analytics:
      reporting_enabled: false
  '';

  tempoConfig = pkgs.writeText "tempo.yaml" ''
    server:
      http_listen_address: ${loopback}
      http_listen_port: ${toString P.ports.tempoHttp}
      grpc_listen_address: ${loopback}
      grpc_listen_port: ${toString P.ports.tempoGrpc}
    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: ${loopback}:${toString P.ports.tempoOtlpGrpc}
            http:
              endpoint: ${loopback}:${toString P.ports.tempoOtlpHttp}
    compactor:
      compaction:
        block_retention: 24h
    metrics_generator:
      registry:
        collection_interval: 15s
        external_labels:
          source: tempo
      storage:
        path: ${config.env.DEVENV_STATE}/tempo/generator/wal
        remote_write:
          - url: http://${loopback}:${toString P.ports.thanosRemoteWrite}/api/v1/receive
            send_exemplars: true
    storage:
      trace:
        backend: local
        wal:
          path: ${config.env.DEVENV_STATE}/tempo/wal
        local:
          path: ${config.env.DEVENV_STATE}/tempo/blocks
    overrides:
      defaults:
        metrics_generator:
          # The per-tenant processor list is what actually turns the generator on.
          # The repo dashboard's classic _bucket series depend on
          # generate_native_histograms staying at its default (classic).
          processors: [span-metrics, service-graphs]
  '';

  grafanaDatasources = pkgs.writeText "grafana-datasources.yaml" ''
    apiVersion: 1
    datasources:
      - name: Prometheus
        type: prometheus
        uid: prometheus # pinned — the repo dashboards hardcode this uid
        access: proxy
        url: http://${loopback}:${toString P.ports.thanosQueryHttp}
        isDefault: true
        editable: false
        jsonData:
          httpMethod: POST
          prometheusType: Thanos
          timeInterval: 15s # match metrics_generator.registry.collection_interval
          # tempo's metrics-generator remote-writes exemplars (send_exemplars);
          # the trace-id label spelling varies by pipeline — register both.
          exemplarTraceIdDestinations:
            - name: traceID
              datasourceUid: tempo
            - name: trace_id
              datasourceUid: tempo
      - name: Tempo
        type: tempo
        uid: tempo # pinned — the repo dashboards hardcode this uid
        access: proxy
        url: http://${loopback}:${toString P.ports.tempoHttp}
        editable: false
        jsonData:
          serviceMap:
            datasourceUid: prometheus
          nodeGraph:
            enabled: true
          tracesToLogsV2:
            datasourceUid: loki
            spanStartTimeShift: "-5m"
            spanEndTimeShift: "5m"
            tags: []
            # OTLP-ingested trace_id lives in Loki structured metadata, not a
            # stream label — filterByTraceID's line filter would never match,
            # so filter on structured metadata via a custom query instead.
            filterByTraceID: false
            filterBySpanID: false
            customQuery: true
            query: '{service_name!=""} | trace_id=`''${__span.traceId}`'
      - name: Loki
        type: loki
        uid: loki # pinned — same convention as the other uids
        access: proxy
        url: http://${loopback}:${toString P.ports.lokiHttp}
        editable: false
        jsonData:
          derivedFields:
            # OTLP ingest stores trace_id as structured metadata — link log lines
            # to their trace in the tempo datasource.
            - name: TraceID
              datasourceUid: tempo
              matcherType: label
              matcherRegex: trace_id
              url: "''${__value.raw}"
              urlDisplayLabel: View trace
  '';

  grafanaDashboards = pkgs.writeText "grafana-dashboards.yaml" ''
    apiVersion: 1
    providers:
      - name: brokkr-dashboards
        type: file
        updateIntervalSeconds: 30
        allowUiUpdates: false
        options:
          path: ${hubRepo}/packages/telemetry/dashboards
          foldersFromFilesStructure: true
  '';

  # File-provisioned alert rules. noDataState/execErrState are OK everywhere:
  # a cold local stack (sink up, hub not exporting yet) must never fire on
  # missing series or eval errors.
  grafanaAlerting = pkgs.writeText "grafana-alerting.yaml" ''
    apiVersion: 1
    groups:
      - orgId: 1
        name: brokkr
        folder: Brokkr
        interval: 1m
        rules:
          - uid: brokkr-high-5xx-span-rate
            title: High 5xx error-span rate
            condition: C
            data:
              - refId: A
                relativeTimeRange:
                  from: 600
                  to: 0
                datasourceUid: prometheus
                model:
                  expr: sum(rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER",status_code="STATUS_CODE_ERROR"}[5m]))
                  instant: true
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: A
              - refId: B
                relativeTimeRange:
                  from: 600
                  to: 0
                datasourceUid: __expr__
                model:
                  type: reduce
                  reducer: last
                  expression: A
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: B
              - refId: C
                relativeTimeRange:
                  from: 600
                  to: 0
                datasourceUid: __expr__
                model:
                  type: threshold
                  expression: B
                  conditions:
                    - evaluator:
                        type: gt
                        params: [0.5]
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: C
            noDataState: OK
            execErrState: OK
            for: 5m
            annotations:
              summary: Error-status server spans (tempo span-metrics) exceed 0.5/s over 5m.
          - uid: brokkr-saga-failures
            title: Saga failures
            condition: C
            data:
              - refId: A
                relativeTimeRange:
                  from: 900
                  to: 0
                datasourceUid: prometheus
                model:
                  # brokkr_saga_completed_total only ever carries status="complete":
                  # bridges report saga failures as job.result/job_failed, never as
                  # job.completed (classifyEventType in the saga framework). Failures
                  # surface via the hub's device-lifecycle transition counter instead.
                  # rate() cannot count a series' birth, so the hub pre-registers the
                  # FAILED label sets at zero on boot (PhoneHomeService /
                  # BridgeResultsConsumer constructors) — the first failure after a
                  # restart is a visible 0→1.
                  expr: sum(rate(brokkr_device_lifecycle_transitions_total{to_status="FAILED"}[15m]))
                  instant: true
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: A
              - refId: B
                relativeTimeRange:
                  from: 900
                  to: 0
                datasourceUid: __expr__
                model:
                  type: reduce
                  reducer: last
                  expression: A
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: B
              - refId: C
                relativeTimeRange:
                  from: 900
                  to: 0
                datasourceUid: __expr__
                model:
                  type: threshold
                  expression: B
                  conditions:
                    - evaluator:
                        type: gt
                        params: [0]
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: C
            noDataState: OK
            execErrState: OK
            for: 5m
            annotations:
              summary: Devices transitioned to lifecycle status FAILED in the last 15m.
              description: Counts hub-written FAILED lifecycle transitions (source label = saga_result | saga_completed | phone_home); failed sagas arrive as job.result/job_failed and never increment brokkr_saga_completed_total.
          - uid: brokkr-zone-offline
            title: Zone offline
            condition: C
            data:
              - refId: A
                relativeTimeRange:
                  from: 600
                  to: 0
                datasourceUid: prometheus
                model:
                  # suppressed="false" excludes flapping zones (their human offline
                  # alert is suppressed, so the provisioned alert must not fire either).
                  # increase() cannot count a series' birth, so the hub pre-registers
                  # {to="offline",suppressed="false"} at zero on boot
                  # (HeartbeatMonitorService constructor) — the first offline
                  # transition after a restart is a visible 0→1.
                  expr: increase(brokkr_zone_status_changes_total{to="offline",suppressed="false"}[10m])
                  instant: true
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: A
              - refId: B
                relativeTimeRange:
                  from: 600
                  to: 0
                datasourceUid: __expr__
                model:
                  type: reduce
                  reducer: last
                  expression: A
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: B
              - refId: C
                relativeTimeRange:
                  from: 600
                  to: 0
                datasourceUid: __expr__
                model:
                  type: threshold
                  expression: B
                  conditions:
                    - evaluator:
                        type: gt
                        params: [0]
                  intervalMs: 1000
                  maxDataPoints: 43200
                  refId: C
            noDataState: OK
            execErrState: OK
            for: 0m
            annotations:
              summary: A zone transitioned to offline within the last 10m.
  '';

  # Grafana wants a provisioning ROOT containing datasources/ + dashboards/ subdirs.
  grafanaProvisioning = pkgs.runCommand "grafana-provisioning" { } ''
    mkdir -p $out/datasources $out/dashboards $out/plugins $out/notifiers $out/alerting
    cp ${grafanaDatasources} $out/datasources/brokkr.yaml
    cp ${grafanaDashboards} $out/dashboards/brokkr.yaml
    cp ${grafanaAlerting} $out/alerting/brokkr.yaml
  '';
in
{
  config = lib.mkIf localStack {
    processes.otel-collector = {
      process-compose = {
        namespace = "observability";
        description = "OTel collector";
        disabled = !enabled;
      };
      exec = ''
        exec ${pkgs.opentelemetry-collector-contrib}/bin/otelcol-contrib --config=${otelcolConfig}
      '';
      ready = {
        http.get = {
          host = loopback;
          port = P.ports.otelcolHealth;
          path = "/";
        };
        initial_delay = 1;
        period = 2;
        probe_timeout = 5;
        failure_threshold = 30;
      };
      restart.on = "on_failure";
    };

    processes.tempo = {
      process-compose = {
        namespace = "observability";
        description = "Tempo";
        disabled = !enabled;
      };
      # Tempo creates its own wal/blocks/generator dirs under $DEVENV_STATE/tempo.
      exec = ''
        exec ${pkgs.tempo}/bin/tempo -config.file=${tempoConfig}
      '';
      ready = {
        http.get = {
          host = loopback;
          port = P.ports.tempoHttp;
          path = "/ready";
        };
        initial_delay = 1;
        period = 2;
        probe_timeout = 5;
        failure_threshold = 30;
      };
      restart.on = "on_failure";
    };

    processes.loki = {
      process-compose = {
        namespace = "observability";
        description = "Loki";
        disabled = !enabled;
      };
      # Loki creates its own chunks/rules/compactor dirs under $DEVENV_STATE/loki.
      exec = ''
        exec ${pkgs.grafana-loki}/bin/loki -config.file=${lokiConfig}
      '';
      ready = {
        http.get = {
          host = loopback;
          port = P.ports.lokiHttp;
          path = "/ready";
        };
        initial_delay = 1;
        period = 2;
        probe_timeout = 5;
        failure_threshold = 30;
      };
      restart.on = "on_failure";
    };

    processes.grafana = {
      process-compose = {
        # LAB_WEB_UI marks this as a browser UI for the control-center "Apps" sidebar; the link
        # port comes from the readiness probe (P.ports.grafana), so no LAB_WEB_PORT override.
        # LAB_WEB_LOOPBACK=true: grafana binds loopback-only even under lan.expose, so the link must
        # target localhost, not the LAN host.
        environment = [
          "LAB_WEB_UI=Grafana"
          "LAB_WEB_LOOPBACK=true"
        ];
        namespace = "observability";
        description = "Grafana";
        disabled = !enabled;
      };
      # The nix-store homepath is read-only, so every writable path is redirected
      # via GF_PATHS_*. Anonymous admin + no login form is local-dev-only posture.
      exec = ''
        mkdir -p "$DEVENV_STATE/grafana"
        export GF_SERVER_HTTP_ADDR=${loopback}
        export GF_SERVER_HTTP_PORT=${toString P.ports.grafana}
        export GF_PATHS_DATA="$DEVENV_STATE/grafana/data"
        export GF_PATHS_PLUGINS="$DEVENV_STATE/grafana/plugins"
        export GF_PATHS_LOGS="$DEVENV_STATE/grafana/logs"
        export GF_PATHS_PROVISIONING=${grafanaProvisioning}
        export GF_AUTH_ANONYMOUS_ENABLED=true
        export GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
        export GF_AUTH_DISABLE_LOGIN_FORM=true
        export GF_USERS_ALLOW_SIGN_UP=false
        export GF_ANALYTICS_REPORTING_ENABLED=false
        export GF_ANALYTICS_CHECK_FOR_UPDATES=false
        exec ${pkgs.grafana}/bin/grafana server --homepath ${pkgs.grafana}/share/grafana
      '';
      ready = {
        http.get = {
          host = loopback;
          port = P.ports.grafana;
          path = "/api/health";
        };
        initial_delay = 1;
        period = 2;
        probe_timeout = 5;
        failure_threshold = 30;
      };
      restart.on = "on_failure";
    };
  };
}
