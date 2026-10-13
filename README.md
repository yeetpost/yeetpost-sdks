# yeetpost SDKs

[yeetpost](https://yeetpost.com) is an API for posting to LinkedIn, X, Bluesky, Discord, Telegram, Mastodon, Reddit, Facebook, Instagram, Threads and Google Business Profile. These are the official client libraries. API docs: https://yeetpost.com/docs

| Language | Path | Install | Docs |
|---|---|---|---|
| Go | [sdks/go](sdks/go) | `go get github.com/yeetpost/yeetpost-sdks/sdks/go` | [README](sdks/go/README.md) |
| Node | [sdks/node](sdks/node) | `cd sdks/node && yarn install && yarn build` | [README](sdks/node/README.md) |
| Python | [sdks/python](sdks/python) | `pip install ./sdks/python` | [README](sdks/python/README.md) |
| PHP | [sdks/php](sdks/php) | Not on Packagist yet. From source: `composer config repositories.yeetpost path ./sdks/php && composer require yeetpost/yeetpost` | [README](sdks/php/README.md) |

Each SDK is a thin, hand-written client with no runtime dependencies.

License: MIT
