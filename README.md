# nospace

Type `helloworld`, get `hello world`. A TypeScript library that adds spaces as you type, with optional typo correction.

```sh
npm install git+ssh://git@github.com/riesvile/nospace.git
```

```ts
import { createHttpProvider } from '@riesvile/nospace';
import { attachNoSpace } from '@riesvile/nospace/dom';

const session = attachNoSpace(document.querySelector('textarea')!, {
  provider: createHttpProvider({
    analyzeUrl: '/api/nospace/analyze',
    correctUrl: '/api/nospace/correct',
  }),
});
```

Those routes run on your server. Jev handles spacing, Luna handles spelling, and you supply the API keys. The demo lives separately.

Works with inputs and textareas; other editors can use the headless API. Built for English, still experimental. Requires Node 22.12+.

[Setup and API details](docs/integration.md) · [How it works](docs/architecture.md)

[Apache-2.0](LICENSE). Word list from [Wordninja](https://github.com/keredson/wordninja) (MIT).
