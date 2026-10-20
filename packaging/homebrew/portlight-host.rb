class PortlightHost < Formula
  desc "Native helper for the Portlight browser extension"
  homepage "https://www.npmjs.com/package/portlight-host"
  url "https://registry.npmjs.org/portlight-host/-/portlight-host-0.1.0.tgz"
  sha256 "92d3737570a3ab29306d06f8c722741ab7826e0b9f620845de6dd2b1a8ad6aec"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      To connect the helper to your browsers, run:
        portlight-host install

      It copies the helper to a per-user folder and registers it with Chrome,
      Chromium, Brave, Edge, Arc and Vivaldi. Run it again after `brew upgrade`.
      To remove it: portlight-host uninstall
    EOS
  end

  test do
    assert_match "portlight-host install", shell_output("#{bin}/portlight-host --help")
    request = '{"id":"t","type":"ping"}'
    ping = [request.bytesize].pack("V") + request
    output = pipe_output("#{bin}/portlight-host chrome-extension://mfnkpeccejhabclngfmkadokknojffeo/", ping)
    assert_match '"type":"pong"', output
  end
end
