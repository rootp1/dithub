import { UsageError } from '../errors.ts'

export const TREE: Record<string, string[]> = {
  login: [], logout: [], whoami: [], auth: ['status', 'login', 'logout'], clone: [], init: [], credential: ['get', 'store', 'erase'],
  repo: ['create', 'list', 'view', 'collaborators', 'grant-team'], protect: ['set', 'remove', 'list'],
  issue: ['list', 'view', 'create', 'comment', 'close', 'reopen', 'label', 'assign', 'import'],
  pr: ['list', 'view', 'create', 'diff', 'files', 'checks', 'review', 'merge', 'close', 'reopen', 'checkout'],
  org: ['list', 'view', 'create', 'members', 'team', 'log'],
  session: ['list', 'open', 'issue', 'ls', 'cat', 'export', 'ask', 'summarize', 'propose', 'end', 'create', 'revoke', 'events'],
  verify: ['site', 'commit'], log: [], completion: ['bash', 'zsh'], version: [], help: [],
}
const GIT = 'push pull fetch status add commit branch checkout switch merge rebase diff stash remote tag reset restore show'

export function completion(argv: string[]): number {
  const shell = argv[0]
  const top = [...Object.keys(TREE), ...GIT.split(' ')].join(' ')
  if (shell === 'bash') {
    const cases = Object.entries(TREE).filter(([, v]) => v.length).map(([k, v]) => `    ${k}) COMPREPLY=( $(compgen -W "${v.join(' ')}" -- "$cur") ) ;;`).join('\n')
    process.stdout.write(`# bash completion for dit
_dit() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${top}" -- "$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
    *) COMPREPLY=( $(compgen -W "--host --json --repo --help" -- "$cur") ) ;;
  esac
}
complete -F _dit dit
`)
    return 0
  }
  if (shell === 'zsh') {
    const cases = Object.entries(TREE).filter(([, v]) => v.length).map(([k, v]) => `    ${k}) _values 'subcommand' ${v.map((x) => `'${x}'`).join(' ')} ;;`).join('\n')
    process.stdout.write(`#compdef dit
# zsh completion for dit
_dit() {
  if (( CURRENT == 2 )); then
    _values 'command' ${top.split(' ').map((x) => `'${x}'`).join(' ')}
    return
  fi
  case "$words[2]" in
${cases}
    *) _values 'option' '--host' '--json' '--repo' '--help' ;;
  esac
}
compdef _dit dit
`)
    return 0
  }
  throw new UsageError('usage: dit completion bash|zsh')
}
