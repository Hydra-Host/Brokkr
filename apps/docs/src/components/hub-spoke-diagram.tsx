export function HubSpokeDiagram() {
  return (
    <div style={{ margin: '2rem auto', maxWidth: '1080px' }}>
      <svg id="bz-arch" viewBox="170 360 1300 1084" style={{ width: '100%', height: 'auto', display: 'block' }}>
        <style>{`
          #bz-arch text{font-family:'JetBrains Mono','IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
          #bz-arch .bz-bg{fill:var(--color-bg-primary,#0c0a17)}
          #bz-arch .bz-hub{fill:var(--color-bg-secondary,#141120);stroke:var(--color-accent-dim,#8f86fa);stroke-width:2}
          #bz-arch .bz-container{fill:var(--color-bg-secondary,#141120);stroke:var(--color-border-dim,#2e2a42);stroke-width:2}
          #bz-arch .bz-box{fill:var(--color-bg-sidebar,#181526);stroke-width:2}
          #bz-arch .bz-brokkr{stroke:var(--color-status-info,#60a5fa)}
          #bz-arch .bz-pg{stroke:var(--color-status-online,#6fec4f)}
          #bz-arch .bz-redis{stroke:var(--color-status-price,#ff8400)}
          #bz-arch .bz-bridge{stroke:var(--color-accent-dim,#8f86fa)}
          #bz-arch .bz-srv{stroke:var(--color-text-dim,#706b8e)}
          #bz-arch .bz-srv-front{stroke:var(--color-border,#a8a3c4)}
          #bz-arch .bz-wire{fill:none;stroke:var(--color-accent-dim,#8f86fa);stroke-width:2;stroke-linejoin:round}
          #bz-arch .bz-dash{fill:none;stroke:var(--color-accent-dim,#8f86fa);stroke-width:2;stroke-linejoin:round;stroke-dasharray:7 6}
          #bz-arch .bz-head{fill:var(--color-accent-dim,#8f86fa)}
          #bz-arch .bz-title{fill:var(--color-text-primary,#f4f2ff);font-size:42px;font-weight:700;text-anchor:middle}
          #bz-arch .bz-hublabel{fill:var(--color-accent,#eceaff);font-size:28px;font-weight:700;text-anchor:middle}
          #bz-arch .bz-lbl{fill:var(--color-text-primary,#f4f2ff);font-size:22px;text-anchor:middle}
          #bz-arch .bz-sub{fill:var(--color-text-muted,#a8a3c4);font-size:16px;text-anchor:middle}
          #bz-arch .bz-grpc{fill:var(--color-text-primary,#f4f2ff);font-size:18px;text-anchor:middle}
          #bz-arch .bz-flow{fill:var(--color-text-muted,#a8a3c4);font-size:17px;text-anchor:middle}
          #bz-arch .bz-zone{fill:var(--color-text-muted,#a8a3c4);font-size:24px}
          #bz-arch .bz-chip{fill:var(--color-bg-primary,#0c0a17)}
        `}</style>
        <defs>
          <marker
            id="ah"
            viewBox="0 0 14 14"
            refX="12"
            refY="7"
            markerWidth="11"
            markerHeight="11"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path className="bz-head" d="M0,0 L14,7 L0,14 z" />
          </marker>
        </defs>
        <rect className="bz-bg" x="170" y="360" width="1300" height="1084" rx="24" />
        <rect className="bz-hub" x="620" y="460" width="400" height="460" rx="16" />
        <rect className="bz-container" x="250" y="988" width="460" height="192" rx="16" />
        <rect className="bz-container" x="930" y="988" width="460" height="192" rx="16" />
        <rect className="bz-container" x="250" y="1198" width="460" height="190" rx="16" />
        <rect className="bz-container" x="930" y="1198" width="460" height="190" rx="16" />
        <g>
          <polyline className="bz-wire" points="690,585 660,585 660,710 684,710" markerEnd="url(#ah)" />
          <polyline className="bz-wire" points="950,585 980,585 980,830 956,830" markerEnd="url(#ah)" />
          <polyline className="bz-wire" points="690,1105 740,1105 740,872" markerEnd="url(#ah)" />
          <polyline className="bz-wire" points="690,1313 795,1313 795,872" markerEnd="url(#ah)" />
          <polyline className="bz-wire" points="950,1313 845,1313 845,872" markerEnd="url(#ah)" />
          <polyline className="bz-wire" points="950,1105 900,1105 900,872" markerEnd="url(#ah)" />
          <line className="bz-wire" x1="530" y1="1105" x2="458" y2="1105" markerEnd="url(#ah)" />
          <line className="bz-wire" x1="1110" y1="1105" x2="1182" y2="1105" markerEnd="url(#ah)" />
          <line className="bz-wire" x1="530" y1="1313" x2="458" y2="1313" markerEnd="url(#ah)" />
          <line className="bz-wire" x1="1110" y1="1313" x2="1182" y2="1313" markerEnd="url(#ah)" />
          <polyline className="bz-dash" points="294,1105 220,1105 220,500 720,500 720,540" markerEnd="url(#ah)" />
        </g>
        <rect className="bz-box bz-brokkr" x="690" y="540" width="260" height="90" rx="12" />
        <rect className="bz-box bz-pg" x="690" y="670" width="260" height="80" rx="12" />
        <rect className="bz-box bz-redis" x="690" y="790" width="260" height="80" rx="12" />
        <rect className="bz-box bz-srv" x="270" y="1036" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv" x="282" y="1048" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv-front" x="294" y="1060" width="160" height="90" rx="12" />
        <rect className="bz-box bz-bridge" x="530" y="1060" width="160" height="90" rx="12" />
        <rect className="bz-box bz-bridge" x="950" y="1060" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv" x="1210" y="1036" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv" x="1198" y="1048" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv-front" x="1186" y="1060" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv" x="270" y="1244" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv" x="282" y="1256" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv-front" x="294" y="1268" width="160" height="90" rx="12" />
        <rect className="bz-box bz-bridge" x="530" y="1268" width="160" height="90" rx="12" />
        <rect className="bz-box bz-bridge" x="950" y="1268" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv" x="1210" y="1244" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv" x="1198" y="1256" width="160" height="90" rx="12" />
        <rect className="bz-box bz-srv-front" x="1186" y="1268" width="160" height="90" rx="12" />
        <rect className="bz-chip" x="754" y="926" width="132" height="26" rx="6" />
        <text className="bz-flow" x="820" y="944">
          jobs · results
        </text>
        <text className="bz-flow" x="316" y="742">
          phone-home
        </text>
        <text className="bz-title" x="820" y="418">
          Hub and Spoke Architecture
        </text>
        <text className="bz-hublabel" x="820" y="500">
          Brokkr Hub
        </text>
        <text className="bz-lbl" x="820" y="591">
          Brokkr
        </text>
        <text className="bz-lbl" x="820" y="716">
          Postgres
        </text>
        <text className="bz-lbl" x="820" y="824">
          Redis
          <tspan className="bz-sub" x="820" dy="19">
            BullMQ bus
          </tspan>
        </text>
        <text className="bz-lbl" x="374" y="1100">
          Servers
          <tspan className="bz-sub" x="374" dy="20">
            Live Agent
          </tspan>
        </text>
        <text className="bz-lbl" x="610" y="1111">
          Bridge
        </text>
        <text className="bz-lbl" x="1030" y="1111">
          Bridge
        </text>
        <text className="bz-lbl" x="1266" y="1100">
          Servers
          <tspan className="bz-sub" x="1266" dy="20">
            Live Agent
          </tspan>
        </text>
        <text className="bz-lbl" x="374" y="1308">
          Servers
          <tspan className="bz-sub" x="374" dy="20">
            Live Agent
          </tspan>
        </text>
        <text className="bz-lbl" x="610" y="1319">
          Bridge
        </text>
        <text className="bz-lbl" x="1030" y="1319">
          Bridge
        </text>
        <text className="bz-lbl" x="1266" y="1308">
          Servers
          <tspan className="bz-sub" x="1266" dy="20">
            Live Agent
          </tspan>
        </text>
        <g className="bz-zone">
          <text x="270" y="1024">
            Zone 1
          </text>
          <text x="950" y="1024">
            Zone 2
          </text>
          <text x="270" y="1234">
            Zone 3
          </text>
          <text x="950" y="1234">
            Zone 4
          </text>
        </g>
        <g className="bz-grpc">
          <text x="492" y="1094">
            gRPC
          </text>
          <text x="1148" y="1094">
            gRPC
          </text>
          <text x="492" y="1302">
            gRPC
          </text>
          <text x="1148" y="1302">
            gRPC
          </text>
        </g>
      </svg>
    </div>
  );
}
