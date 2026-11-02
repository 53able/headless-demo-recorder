# Shell shown in the recording: a short prompt without the user's name or home path.
# /etc/zshrc points HISTFILE into this (tracked) directory; keep typed commands out of the repo.
unset HISTFILE
PROMPT='%F{green}demo%f %F{cyan}headless-demo-recorder%f $ '
# The shorthand the README uses: headless-demo-recorder <cmd> = bun <skill-dir>/scripts/cli.ts <cmd>.
headless-demo-recorder() { bun "$HDR_ROOT/skills/headless-demo-recorder/scripts/cli.ts" "$@"; }
# npx skills: no usage reporting from the recording machine.
export DISABLE_TELEMETRY=1
cd "$HDR_ROOT"
clear
