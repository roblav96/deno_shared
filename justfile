#!/usr/bin/env just --justfile
# https://github.com/casey/just

_default :
	@just --dump

install :
	deno cache --unstable --no-check --reload src/**/*.ts || true

run main="src/mod.ts" :
	@tput clear; echo
	@deno cache --unstable {{main}} || true; echo
	@deno run --unstable --no-check --allow-all {{main}}
watch main="src/mod.ts" :
	watchexec --no-default-ignore --restart --watch=src --exts=ts -- just run {{main}}

bundle source_file :
	deno bundle --unstable --no-check {{source_file}}
