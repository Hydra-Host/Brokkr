export function LifecycleDiagram() {
  return (
    <div id="lifecycle-figs">
      <style>{`@media (max-width:767px){#lifecycle-figs .life-desktop{display:none}}@media (min-width:768px){#lifecycle-figs .life-mobile{display:none}}`}</style>
      <div className="life-desktop" style={{ margin: '2rem auto', maxWidth: '1180px' }}>
        <svg id="dl" viewBox="40 255 1690 520" style={{ width: '100%', height: 'auto', display: 'block' }}>
          <style>{`
          #dl text{font-family:'JetBrains Mono','IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
          #dl .dl-bg{fill:var(--color-bg-primary,#0c0a17)}
          #dl .dl-box{fill:var(--color-bg-sidebar,#181526);stroke-width:2}
          #dl .dl-inv{stroke:var(--color-text-muted,#a8a3c4)}
          #dl .dl-prov{stroke:var(--color-status-price,#ff8400)}
          #dl .dl-pv{stroke:var(--color-status-online,#6fec4f)}
          #dl .dl-dep{stroke:var(--color-status-purple,#c084fc)}
          #dl .dl-com{stroke:var(--color-status-info,#60a5fa)}
          #dl .dl-dec{stroke:var(--color-status-offline,#ff383b)}
          #dl .dl-wire{fill:none;stroke:var(--color-accent-dim,#8f86fa);stroke-width:2;stroke-linejoin:round}
          #dl .dl-head{fill:var(--color-accent-dim,#8f86fa)}
          #dl .dl-state{fill:var(--color-text-primary,#f4f2ff);font-size:26px;text-anchor:middle;dominant-baseline:central}
          #dl .dl-pill{fill:var(--color-text-primary,#f4f2ff);font-size:22px;text-anchor:middle;dominant-baseline:central}
          #dl .dl-mech{fill:var(--color-text-muted,#a8a3c4);font-size:18px}
          #dl .dl-lbl{fill:var(--color-text-primary,#f4f2ff);font-size:18px;text-anchor:middle}
          #dl .dl-chip{fill:var(--color-bg-primary,#0c0a17)}
        `}</style>
          <defs>
            <marker
              id="dlah"
              viewBox="0 0 14 14"
              refX="12"
              refY="7"
              markerWidth="11"
              markerHeight="11"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className="dl-head" d="M0,0 L14,7 L0,14 z" />
            </marker>
          </defs>
          <rect className="dl-bg" x="40" y="255" width="1690" height="520" rx="24" />
          <g>
            <line className="dl-wire" x1="380" y1="510" x2="556" y2="510" markerEnd="url(#dlah)" />
            <line className="dl-wire" x1="820" y1="510" x2="996" y2="510" markerEnd="url(#dlah)" />
            <line className="dl-wire" x1="1260" y1="510" x2="1436" y2="510" markerEnd="url(#dlah)" />
            <polyline className="dl-wire" points="1570,460 1570,408 250,408 250,454" markerEnd="url(#dlah)" />
            <polyline className="dl-wire" points="120,319 76,319 76,498 114,498" markerEnd="url(#dlah)" />
            <polyline className="dl-wire" points="120,524 76,524 76,706 114,706" markerEnd="url(#dlah)" />
          </g>
          <rect className="dl-box dl-inv" x="120" y="460" width="260" height="100" rx="14" />
          <rect className="dl-box dl-prov" x="560" y="460" width="260" height="100" rx="14" />
          <rect className="dl-box dl-pv" x="1000" y="460" width="260" height="100" rx="14" />
          <rect className="dl-box dl-dep" x="1440" y="460" width="260" height="100" rx="14" />
          <rect className="dl-box dl-com" x="120" y="287" width="260" height="64" rx="32" />
          <rect className="dl-box dl-dec" x="120" y="674" width="260" height="64" rx="32" />
          <text className="dl-state" x="250" y="510">
            Inventory
          </text>
          <text className="dl-state" x="690" y="510">
            Provisioning
          </text>
          <text className="dl-state" x="1130" y="510">
            Provisioned
          </text>
          <text className="dl-state" x="1570" y="510">
            Deprovisioning
          </text>
          <text className="dl-pill" x="250" y="319">
            Commission
          </text>
          <text className="dl-pill" x="250" y="706">
            Decommission
          </text>
          <text className="dl-lbl" x="468" y="494">
            provision
          </text>
          <text className="dl-lbl" x="908" y="494">
            phone-home
          </text>
          <text className="dl-lbl" x="1348" y="494">
            deprovision
          </text>
          <rect className="dl-chip" x="838" y="395" width="144" height="26" rx="6" />
          <text className="dl-lbl" x="910" y="412">
            wipe complete
          </text>
          <text className="dl-mech" x="122" y="592">
            · Boots Brokkr Live
            <tspan x="122" dy="20">
              · Hardware discovery
            </tspan>
            <tspan x="122" dy="20">
              · Unassigned, idle
            </tspan>
          </text>
          <text className="dl-mech" x="562" y="592">
            · BMC power on, PXE boot
            <tspan x="562" dy="20">
              · Boot Brokkr Live
            </tspan>
            <tspan x="562" dy="20">
              · Wipe, install OS
            </tspan>
            <tspan x="562" dy="20">
              · Next boot set to disk
            </tspan>
          </text>
          <text className="dl-mech" x="1002" y="592">
            · Installed OS boots
            <tspan x="1002" dy="20">
              · Phones home to hub
            </tspan>
            <tspan x="1002" dy="20">
              · Running the workload
            </tspan>
          </text>
          <text className="dl-mech" x="1442" y="592">
            · BMC power, PXE boot
            <tspan x="1442" dy="20">
              · Boot Brokkr Live
            </tspan>
            <tspan x="1442" dy="20">
              · Wipe disks
            </tspan>
          </text>
        </svg>
      </div>
      <div className="life-mobile" style={{ margin: '1.5rem auto', maxWidth: '760px' }}>
        <svg id="dlv" viewBox="270 1160 840 880" style={{ width: '100%', height: 'auto', display: 'block' }}>
          <style>{`
          #dlv text{font-family:'JetBrains Mono','IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
          #dlv .dlv-bg{fill:var(--color-bg-primary,#0c0a17)}
          #dlv .dlv-box{fill:var(--color-bg-sidebar,#181526);stroke-width:2}
          #dlv .dlv-inv{stroke:var(--color-text-muted,#a8a3c4)}
          #dlv .dlv-prov{stroke:var(--color-status-price,#ff8400)}
          #dlv .dlv-pv{stroke:var(--color-status-online,#6fec4f)}
          #dlv .dlv-dep{stroke:var(--color-status-purple,#c084fc)}
          #dlv .dlv-com{stroke:var(--color-status-info,#60a5fa)}
          #dlv .dlv-dec{stroke:var(--color-status-offline,#ff383b)}
          #dlv .dlv-wire{fill:none;stroke:var(--color-accent-dim,#8f86fa);stroke-width:2;stroke-linejoin:round}
          #dlv .dlv-head{fill:var(--color-accent-dim,#8f86fa)}
          #dlv .dlv-state{fill:var(--color-text-primary,#f4f2ff);font-size:22px;text-anchor:middle;dominant-baseline:central}
          #dlv .dlv-pill{fill:var(--color-text-primary,#f4f2ff);font-size:20px;text-anchor:middle;dominant-baseline:central}
          #dlv .dlv-mech{fill:var(--color-text-muted,#a8a3c4);font-size:15px}
          #dlv .dlv-lbl{fill:var(--color-text-primary,#f4f2ff);font-size:15px;text-anchor:middle}
          #dlv .dlv-chip{fill:var(--color-bg-primary,#0c0a17)}
        `}</style>
          <defs>
            <marker
              id="dlvah"
              viewBox="0 0 14 14"
              refX="12"
              refY="7"
              markerWidth="11"
              markerHeight="11"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className="dlv-head" d="M0,0 L14,7 L0,14 z" />
            </marker>
          </defs>
          <rect className="dlv-bg" x="270" y="1160" width="840" height="880" rx="24" />
          <g>
            <line className="dlv-wire" x1="689" y1="1430" x2="689" y2="1519" markerEnd="url(#dlvah)" />
            <line className="dlv-wire" x1="689" y1="1623" x2="689" y2="1712" markerEnd="url(#dlvah)" />
            <line className="dlv-wire" x1="689" y1="1816" x2="689" y2="1905" markerEnd="url(#dlvah)" />
            <polyline className="dlv-wire" points="819,1959 900,1959 900,1380 823,1380" markerEnd="url(#dlvah)" />
            <polyline className="dlv-wire" points="429,1258 429,1300 620,1300 620,1326" markerEnd="url(#dlvah)" />
            <polyline className="dlv-wire" points="760,1330 760,1300 949,1300 949,1262" markerEnd="url(#dlvah)" />
          </g>
          <rect className="dlv-box dlv-inv" x="559" y="1330" width="260" height="100" rx="14" />
          <rect className="dlv-box dlv-prov" x="559" y="1523" width="260" height="100" rx="14" />
          <rect className="dlv-box dlv-pv" x="559" y="1716" width="260" height="100" rx="14" />
          <rect className="dlv-box dlv-dep" x="559" y="1909" width="260" height="100" rx="14" />
          <rect className="dlv-box dlv-com" x="299" y="1194" width="260" height="64" rx="32" />
          <rect className="dlv-box dlv-dec" x="819" y="1194" width="260" height="64" rx="32" />
          <text className="dlv-state" x="689" y="1380">
            Inventory
          </text>
          <text className="dlv-state" x="689" y="1573">
            Provisioning
          </text>
          <text className="dlv-state" x="689" y="1766">
            Provisioned
          </text>
          <text className="dlv-state" x="689" y="1959">
            Deprovisioning
          </text>
          <text className="dlv-pill" x="429" y="1226">
            Commission
          </text>
          <text className="dlv-pill" x="949" y="1226">
            Decommission
          </text>
          <rect className="dlv-chip" x="644" y="1463" width="90" height="26" rx="6" />
          <text className="dlv-lbl" x="689" y="1480">
            provision
          </text>
          <rect className="dlv-chip" x="639" y="1656" width="100" height="26" rx="6" />
          <text className="dlv-lbl" x="689" y="1673">
            phone-home
          </text>
          <rect className="dlv-chip" x="634" y="1849" width="110" height="26" rx="6" />
          <text className="dlv-lbl" x="689" y="1866">
            deprovision
          </text>
          <text className="dlv-lbl" transform="rotate(-90 915 1670)" x="915" y="1670">
            wipe complete
          </text>
          <text className="dlv-mech" x="303" y="1368">
            · Boots Brokkr Live
            <tspan x="303" dy="20">
              · Hardware discovery
            </tspan>
            <tspan x="303" dy="20">
              · Unassigned, idle
            </tspan>
          </text>
          <text className="dlv-mech" x="303" y="1551">
            · BMC power on, PXE boot
            <tspan x="303" dy="20">
              · Boot Brokkr Live
            </tspan>
            <tspan x="303" dy="20">
              · Wipe, install OS
            </tspan>
            <tspan x="303" dy="20">
              · Next boot set to disk
            </tspan>
          </text>
          <text className="dlv-mech" x="303" y="1754">
            · Installed OS boots
            <tspan x="303" dy="20">
              · Phones home to hub
            </tspan>
            <tspan x="303" dy="20">
              · Running the workload
            </tspan>
          </text>
          <text className="dlv-mech" x="303" y="1947">
            · BMC power, PXE boot
            <tspan x="303" dy="20">
              · Boot Brokkr Live
            </tspan>
            <tspan x="303" dy="20">
              · Wipe disks
            </tspan>
          </text>
        </svg>
      </div>
    </div>
  );
}
