# Third-Party Notices

SQLAdmin's own code is licensed separately — see [LICENSE.md](./LICENSE.md)
(PolyForm Noncommercial License 1.0.0).

This file covers two groups:

1. **Bundled components** — code or assets embedded in `frontend/dist` and
   shipped inside the Docker image. Their notices are reproduced in full here
   because this project redistributes them.
2. **Runtime dependencies** — installed separately (via `npm ci` / `poetry
   install`) rather than embedded into the shipped artifact. Each ships its
   own license text within its own package; they are listed here for
   completeness.

---

## 1. Components bundled in the image

### Font Awesome Free 7.2.0 — icon path data

Icon path data derived from Font Awesome Free 7.2.0, © Fonticons, Inc.,
licensed under the Creative Commons Attribution 4.0 International License (CC
BY 4.0), reaches `frontend/dist` via `@jimka/typescript-ui`.

- Creator: Fonticons, Inc.
- License: <https://creativecommons.org/licenses/by/4.0/>
- Source: <https://fontawesome.com/license/free>

Path data was extracted from the upstream SVG sources and reformatted as
TypeScript constants. The path `d` attribute and `viewBox` values are
unchanged from the upstream files.

The full legal code of CC BY 4.0 is available at
<https://creativecommons.org/licenses/by/4.0/legalcode.txt>.

### Manrope — variable font, Latin & Latin-Extended subsets

The Latin and Latin-Extended subsets of the Manrope variable font are
embedded (as WOFF2 data) in `@jimka/typescript-ui`'s theme assets, which
reach `frontend/dist`. `Manrope` is a Reserved Font Name under the license
below.

```
Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### elkjs 0.10.2 — Eclipse Layout Kernel (JavaScript)

© Kiel University and contributors, licensed under the Eclipse Public License
2.0 (EPL-2.0). Unlike `@jimka/typescript-ui`'s own optional, dynamically
imported use of `elkjs`, SQLAdmin's Vite build bundles it unmodified into
`dist/assets/elk.bundled-*.js`.

- Source: <https://github.com/kieler/elkjs>
- Full license text: <https://www.eclipse.org/legal/epl-2.0/>

---

## 2. Frontend runtime dependencies

Installed from npm via `npm ci` into `frontend/node_modules`. Each ships its
own license text within its own package; listed here for completeness.

<!-- BEGIN GENERATED: npm -->
| Package | Version | License |
|---|---|---|
| @codemirror/autocomplete | 6.20.3 | MIT |
| @codemirror/commands | 6.10.4 | MIT |
| @codemirror/lang-css | 6.3.1 | MIT |
| @codemirror/lang-html | 6.4.11 | MIT |
| @codemirror/lang-javascript | 6.2.5 | MIT |
| @codemirror/lang-json | 6.0.2 | MIT |
| @codemirror/lang-markdown | 6.5.1 | MIT |
| @codemirror/lang-sql | 6.10.0 | MIT |
| @codemirror/language | 6.12.4 | MIT |
| @codemirror/lint | 6.9.7 | MIT |
| @codemirror/search | 6.7.1 | MIT |
| @codemirror/state | 6.7.1 | MIT |
| @codemirror/view | 6.43.6 | MIT |
| @fontsource-variable/manrope | 5.3.0 | OFL-1.1 |
| @jimka/typescript-ui | 0.1.0 | PolyForm-Noncommercial-1.0.0 |
| @lexical/clipboard | 0.46.0 | MIT |
| @lexical/code | 0.46.0 | MIT |
| @lexical/code-core | 0.46.0 | MIT |
| @lexical/code-prism | 0.46.0 | MIT |
| @lexical/dragon | 0.46.0 | MIT |
| @lexical/extension | 0.46.0 | MIT |
| @lexical/history | 0.46.0 | MIT |
| @lexical/html | 0.46.0 | MIT |
| @lexical/internal | 0.46.0 | MIT |
| @lexical/link | 0.46.0 | MIT |
| @lexical/list | 0.46.0 | MIT |
| @lexical/markdown | 0.46.0 | MIT |
| @lexical/rich-text | 0.46.0 | MIT |
| @lexical/selection | 0.46.0 | MIT |
| @lexical/text | 0.46.0 | MIT |
| @lexical/utils | 0.46.0 | MIT |
| @lezer/common | 1.5.2 | MIT |
| @lezer/css | 1.3.4 | MIT |
| @lezer/highlight | 1.2.3 | MIT |
| @lezer/html | 1.3.13 | MIT |
| @lezer/javascript | 1.5.4 | MIT |
| @lezer/json | 1.0.3 | MIT |
| @lezer/lr | 1.4.10 | MIT |
| @lezer/markdown | 1.7.2 | MIT |
| @marijn/find-cluster-break | 1.0.3 | MIT |
| @preact/signals-core | 1.14.4 | MIT |
| @types/trusted-types | 2.0.7 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| codemirror | 6.0.2 | MIT |
| commander | 2.20.3 | MIT |
| crelt | 1.0.7 | MIT |
| d3-array | 3.2.4 | ISC |
| d3-color | 3.1.0 | ISC |
| d3-format | 3.1.2 | ISC |
| d3-interpolate | 3.0.1 | ISC |
| d3-path | 3.1.0 | ISC |
| d3-scale | 4.0.2 | ISC |
| d3-shape | 3.2.0 | ISC |
| d3-time | 3.1.0 | ISC |
| d3-time-format | 4.1.0 | ISC |
| discontinuous-range | 1.0.0 | MIT |
| elkjs | 0.10.2 | EPL-2.0 |
| internmap | 2.0.3 | ISC |
| lexical | 0.46.0 | MIT |
| marked | 18.0.6 | MIT |
| moo | 0.5.3 | BSD-3-Clause |
| nearley | 2.20.1 | MIT |
| prettier | 3.9.5 | MIT |
| prismjs | 1.30.0 | MIT |
| railroad-diagrams | 1.0.0 | CC0-1.0 |
| randexp | 0.4.6 | MIT |
| ret | 0.1.15 | MIT |
| sql-formatter | 15.8.2 | MIT |
| style-mod | 4.1.3 | MIT |
| w3c-keyname | 2.2.8 | MIT |
<!-- END GENERATED: npm -->

---

## 3. Backend runtime dependencies

Installed from PyPI via `poetry install` into the backend's virtual
environment. Each ships its own license text within its own package; listed
here for completeness.

<!-- BEGIN GENERATED: python -->
| Package | Version | License |
|---|---|---|
| annotated-types | 0.7.0 | MIT License |
| anyio | 4.14.1 | MIT |
| async-timeout | 5.0.1 | Apache Software License |
| asyncpg | 0.30.0 | Apache Software License |
| click | 8.4.2 | BSD-3-Clause |
| exceptiongroup | 1.3.1 | MIT License |
| fastapi | 0.115.14 | MIT License |
| h11 | 0.16.0 | MIT License |
| httptools | 0.8.0 | MIT |
| idna | 3.18 | BSD-3-Clause |
| pydantic | 2.13.4 | MIT |
| pydantic-core | 2.46.4 | MIT |
| python-dotenv | 1.2.2 | BSD-3-Clause |
| pyyaml | 6.0.3 | MIT License |
| starlette | 0.46.2 | BSD-3-Clause |
| typing-extensions | 4.15.0 | PSF-2.0 |
| typing-inspection | 0.4.2 | MIT |
| uvicorn | 0.32.1 | BSD License |
| uvloop | 0.22.1 | Apache Software License; MIT License |
| watchfiles | 1.2.0 | MIT License |
| websockets | 16.0 | BSD-3-Clause |
<!-- END GENERATED: python -->
