# Phone-side integrity agent

This is the small program injected into Android's myVW process by Frida.
It runs inside Frida's QuickJS runtime on the phone, not Node. The Mac daemon
is Rust, in `../integrity-bridge`.

Keep the source under the repository's strict TypeScript and typed lint rules.
Java objects cross checked `unknown` boundaries; use JNI calls through
`Java.performNow`, never Java hooks or `registerClass` on this Android build.
The exact APK and Frida versions are documented in the daemon README.

The checked-in bundle is embedded into the Rust executable. Ordinary Cargo
builds and the installed service need no Node or npm dependencies. Only when
changing this agent, run `pnpm --filter @vwapp/integrity-agent build`, review the
generated bundle, then rebuild, test and reinstall the Rust service. An agent
change must also be verified against the real phone before deployment.
