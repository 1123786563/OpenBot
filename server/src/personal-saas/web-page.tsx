import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import type { Hono } from "hono";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const styleFiles = [
  new URL(import.meta.resolve("@astryxdesign/core/reset.css")),
  new URL(import.meta.resolve("@astryxdesign/core/astryx.css")),
  new URL(import.meta.resolve("@astryxdesign/theme-neutral/theme.css")),
];

// Astryx serializes the template's VStack width and Section maxWidth as attributes.
export const pageStyleAttributePolicy =
  "style-src-attr 'unsafe-hashes' 'sha256-t6oewASd7J1vBg5mQtX4hl8bg8FeegYFM3scKLIhYUc=' 'sha256-FTrp4OJYdWLHOhdSEuNEl1qvIdRdXU3Q0g3ZihA0iTo='";

export function registerPageStyles(app: Hono) {
  let styles: Promise<string> | undefined;
  app.get("/assets/entry.css", async (context) => {
    styles ??= Promise.all(styleFiles.map((url) => Bun.file(url).text())).then(
      (parts) => parts.join("\n"),
    );
    context.header("Content-Type", "text/css; charset=utf-8");
    return context.body(await styles);
  });
}

export function page(title: string, contents: ReactNode) {
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <html lang="en" data-astryx-theme="neutral">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{`${title} · OpenBot`}</title>
          <link rel="stylesheet" href="/assets/entry.css" />
        </head>
        <body>
          <main>
            <Center axis="horizontal">
              <VStack width="100%" hAlign="center">
                <Section
                  maxWidth={800}
                  padding={6}
                  paddingBlock={10}
                  variant="section"
                >
                  <VStack gap={6}>
                    <VStack gap={2} hAlign="center">
                      <Text as="p" type="label" weight="bold">
                        OpenBot
                      </Text>
                      <Heading level={1} type="display-1">
                        {title}
                      </Heading>
                    </VStack>
                    <VStack gap={5}>{contents}</VStack>
                  </VStack>
                </Section>
              </VStack>
            </Center>
          </main>
        </body>
      </html>,
    )
  );
}
