#!/usr/bin/env sh
# GIT_ASKPASS helper — reads SOLSTAK_GIT_USER / SOLSTAK_GIT_PASSWORD from the environment.
case "$1" in
  *[Uu]sername*) printf '%s' "${SOLSTAK_GIT_USER:-}" ;;
  *[Pp]assword*) printf '%s' "${SOLSTAK_GIT_PASSWORD:-}" ;;
  *) exit 1 ;;
esac
