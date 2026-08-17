import type { Command } from 'commander';
import { candidatesFor, visibleSubcommands } from './walk.js';

interface CommandNode {
  path: string;
  candidates: string;
}

function collectNodes(cmd: Command, pathWords: string[] = [], out: CommandNode[] = []): CommandNode[] {
  out.push({ path: pathWords.join(' '), candidates: candidatesFor(cmd).join(' ') });
  for (const sub of visibleSubcommands(cmd)) {
    collectNodes(sub, [...pathWords, sub.name()], out);
  }
  return out;
}

function bashSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function generateStaticBashCompletion(root: Command): string {
  const nodes = collectNodes(root);
  const pathAlts = nodes
    .filter((n) => n.path !== '')
    .map((n) => bashSingleQuote(n.path))
    .join('|');
  const candidateCases = nodes
    .map((n) => {
      const pattern = n.path === '' ? "''" : bashSingleQuote(n.path);
      return `    ${pattern}) __brokkr_cands=${bashSingleQuote(n.candidates)} ;;`;
    })
    .join('\n');

  return `# brokkr bash completion (static)
_brokkr_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local path=""
  local i=1
  while [ $i -lt $COMP_CWORD ]; do
    local w="\${COMP_WORDS[$i]}"
    if [[ "$w" == -* ]]; then break; fi
    local trial
    if [ -z "$path" ]; then trial="$w"; else trial="$path $w"; fi
    case "$trial" in
      ${pathAlts})
        path="$trial"
        ;;
      *)
        break
        ;;
    esac
    i=$((i+1))
  done
  local __brokkr_cands=""
  case "$path" in
${candidateCases}
  esac
  COMPREPLY=( $(compgen -W "$__brokkr_cands" -- "$cur") )
}
complete -o default -F _brokkr_complete brokkr
`;
}
