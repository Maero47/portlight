# Homebrew formula

`portlight-host.rb` installs the Portlight helper from the npm registry. It belongs in a
tap repository named `maero47/homebrew-tap`, as `Formula/portlight-host.rb`, so people
can run:

```sh
brew install maero47/tap/portlight-host
portlight-host install
```

Homebrew only puts the `portlight-host` command on PATH. Its sandbox can't write into
browser profiles, so the formula's caveats tell people to run `portlight-host install`
themselves. That copies the helper out of the Cellar into a per-user folder, so a later
`brew upgrade` or `brew cleanup` never breaks the browser's link to it. The launcher it
writes points at Homebrew's `opt/node` link rather than a versioned Cellar path, so it
survives `brew upgrade node` too.

## After publishing a new version to npm

```sh
./bump.sh            # latest version on npm, or ./bump.sh 0.2.0
```

It downloads the tarball from the registry, checks it against npm's recorded integrity,
and rewrites `url` and `sha256` in the formula. Copy the formula into the tap, then check
it there:

```sh
brew audit --strict --online maero47/tap/portlight-host
brew install --build-from-source maero47/tap/portlight-host
brew test maero47/tap/portlight-host
```

The `sha256` committed here comes from `npm pack` of the current source. The registry
tarball can differ byte for byte, so run `./bump.sh` once after the first publish.
