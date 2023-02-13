# Caching-proxy

This is a little no-dependencies node app that intends to replace runtime dependencies for local development
when they can be effectively served by fixtures. It sits in front of a backend, proxying requests and saving
responses in files in the `cache` folder, named by the sha1 of the request + graphql operation (when it exists).
When subsequent requests come it will serve the cached response if it exists, otherwise it will proxy and save a
new cached response from the backend.

## Build

```
yarn build
```

## Run

### CLI help

```
yarn start --help
```

### Example

```
yarn start --port 3000 --proxy-port 7001
```

### Skip cache (always proxy and overwrite cache)

```
yarn start --skip-cache --port 3000 --proxy-port 7001
```

### Clear cache

```
rm -rf cache
```
