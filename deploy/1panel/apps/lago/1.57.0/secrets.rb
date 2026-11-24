require "base64"
require "json"
require "openssl"
require "securerandom"
require "tempfile"

path = "/lago-secrets/keys.json"
generators = {
  "SECRET_KEY_BASE" => -> { SecureRandom.hex(64) },
  "LAGO_RSA_PRIVATE_KEY" => -> { Base64.strict_encode64(OpenSSL::PKey::RSA.generate(2048).to_pem) },
  "LAGO_ENCRYPTION_PRIMARY_KEY" => -> { SecureRandom.hex(16) },
  "LAGO_ENCRYPTION_DETERMINISTIC_KEY" => -> { SecureRandom.hex(16) },
  "LAGO_ENCRYPTION_KEY_DERIVATION_SALT" => -> { SecureRandom.hex(16) },
}

if ARGV == ["--init"]
  File.chown(65532, 65532, File.dirname(path))
  File.chmod(0o700, File.dirname(path))
  unless File.exist?(path)
    secrets = generators.to_h do |name, generate|
      value = ENV.fetch(name, "")
      [name, value.empty? ? generate.call : value]
    end
    Tempfile.create(".keys-", File.dirname(path)) do |file|
      file.write(JSON.generate(secrets))
      file.flush
      file.fsync
      file.chown(65532, 65532)
      begin
        File.link(file.path, path)
      rescue Errno::EEXIST
        # A concurrent initializer already saved this installation's keys.
      end
    end
  end
  saved = JSON.parse(File.read(path))
  generators.each_key do |name|
    supplied = ENV.fetch(name, "")
    abort "Lago secret mismatch for #{name}. Restore the original value." if !supplied.empty? && supplied != saved.fetch(name)
  end
else
  abort "Missing Lago service command" if ARGV.empty?
  secrets = JSON.parse(File.read(path))
  generators.each_key { |name| ENV[name] = secrets.fetch(name) }
  exec(*ARGV)
end
