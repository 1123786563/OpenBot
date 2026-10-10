# Test fixtures

The PEM files here (`payment-test-certificate.pem`, `payment-test-key.pem`) are **test vector
material, not credentials**. They were generated with:

```sh
openssl req -x509 -newkey rsa:2048 -keyout payment-test-key.pem \
  -out payment-test-certificate.pem -days 3650 -nodes \
  -subj "/CN=openbot-payment-test"
```

The certificate's serial (`4473fb87fb910b2526b2c61c3768cc8c3fad5c09`) is pinned in
`payment-crypto.test.ts`. If you regenerate the fixture, re-pin the serial — the pin exists so a
silently different certificate cannot pass the derivation test.
