# nospace

Type `ilovecats`, get `I love cats`. A TypeScript library that adds spaces and corrects typos as you type.

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

Those routes run on your server. Jev checks spacing and context; GPT-6 Luna handles targeted corrections. Includes smart punctuation, sentence and full-text review, and an optional persistent rate limiter.

Works with inputs and textareas - other editors can use the headless API. Built for English, still experimental. Requires Node 22.12+.

[Setup and API details](docs/integration.md) · [How it works](docs/architecture.md)

[Apache-2.0](LICENSE). Word list from [Wordninja](https://github.com/keredson/wordninja) (MIT).
