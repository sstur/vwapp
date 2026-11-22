# Embedded Frida assets

`agent.js` is generated from `../../integrity-agent/index.ts` by esbuild 0.28.1,
including frida-java-bridge 7.0.13 and buffer 5.7.1 (with base64-js 1.5.1 and
ieee754 1.2.1). All versions are pinned by the workspace lockfile. Its SHA-256
at the Rust migration is:

```
9069f446b13de6e7b51bdf111dbb4e32d49e78594207b335f3f883de9d23ddee
```

The migration bundle differs from the previously deployed agent only in its
source-path comment. To regenerate after an intentional agent change, run
`pnpm --filter @vwapp/integrity-agent build`, review the diff and rebuild Rust.
Cargo embeds this file at compile time; the installed binary does not read it
from the checkout. These assets contain no account-specific information.

Frida Core 17.22.2 is fetched from the official GitHub release by `build.rs`,
which pins separate macOS arm64/x86_64 archive SHA-256 checksums. Core source:
<https://github.com/frida/frida-core/tree/17.22.2>. Java bridge source:
<https://github.com/frida/frida-java-bridge/tree/7.0.13>.

`FRIDA-LICENSE.txt` is Frida's wxWindows Library Licence 3.1, including its
exception permitting binary linking under the application's own terms;
`LGPL-2.0.txt` supplies the referenced library licence. Other bundled JS license
notices are retained in `agent.js`; full dependency licenses are in
`JS-LICENSES.txt`. The project-owned agent and Rust code use the repository's
MIT license.
