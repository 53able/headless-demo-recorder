# Shell shown in the recording: a short prompt without the user's name or home path.
# /etc/zshrc points HISTFILE into this (tracked) directory; keep typed commands out of the repo.
unset HISTFILE
PROMPT='%F{green}demo%f %F{cyan}headless-demo-recorder%f $ '
cd "$HDR_ROOT"
clear
