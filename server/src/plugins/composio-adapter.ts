import { Composio } from "@composio/core";
import {
  type BrokerConnection,
  BrokerRefusalError,
  type ComposioBroker,
  type ConnectedAppBroker,
  type FieldScheme,
  flagOf,
  isFieldScheme,
} from "./broker";
import { type ComposioActions, LISTING_LIMIT } from "./composio";
import { accountMethods } from "./composio-client/accounts";
import { actionsFor } from "./composio-client/actions";
import { consentMethods } from "./composio-client/consent";
import { createClientContext } from "./composio-client/context";
import { directoryMethods } from "./composio-client/directory";
import { fieldMethods } from "./composio-client/fields";
import type { ComposioVendor } from "./composio-client/model";

export type { ComposioVendor } from "./composio-client/model";

/**
 * The one file in `server/src` that imports `@composio/core`, and what it owes the rest of them.
 *
 * `./composio` describes calling an action and `./broker` describes everything that has to be true
 * before one can be called; both are written as narrow projections that name no vendor type, so
 * that the SDK's shape — its constructor, its retries, its zod schemas and whatever the next
 * version renames — is confined here. This module is the adapter that satisfies both from one
 * client. A second importer of `@composio/core` under `server/src` would undo that, because the
 * point of a single import site is that a version bump has exactly one file to be read against.
 *
 * NO SESSION IS EVER CREATED, AND THAT IS A SECURITY BOUNDARY RATHER THAN A PREFERENCE. The SDK's
 * `composio.create(...)` and `sessions.create(...)` open a Composio tool-router session, and a
 * session brings Composio's own hosted surface with it — a remote shell and a Python sandbox that
 * this deployment neither asked for, cannot see into, and could not audit if a model reached them.
 * Everything below is a plain per-call request carrying a user id. A `create` of a session
 * anywhere in this file is a defect, not an optimisation, and it will not look like one: the
 * session API is the shortest path to most of what this file does the long way.
 *
 * EVERY LISTING PASSES AN EXPLICIT LIMIT AND EVERY LISTING IS READ TO THE END OF ITS CURSOR.
 * Composio's default page is 20, which is smaller than the number of actions Gmail alone publishes,
 * and through the SDK's tool wrapper the default did a second thing as well: `getRawComposioTools`
 * set `important=true` whenever a toolkit query arrived with no limit, no tags and no search
 * (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so an omitted limit silently narrowed
 * the answer to the vendor's own "important" subset and nothing in the result said a filter had
 * been applied. {@link LISTING_LIMIT} is the documented page ceiling and therefore the fewest round
 * trips a listing can be read in.
 *
 * AND THE LIMIT IS A PAGE RATHER THAN THE ANSWER, WHICH IS WHAT CHANGED. Two of the four listings
 * here used to meet a full page and refuse it, because the SDK wrapper around them could not ask
 * for a second — one takes no cursor, the other drops the response's. That was never true of the
 * vendor: both raw endpoints carry `cursor` and `next_cursor`, and Composio publishes more than
 * {@link LISTING_LIMIT} toolkits, so the catalogue refusal fired on every call and the app picker
 * showed an operator nothing at all. All four now go through {@link everyRowOf}, which follows the
 * cursor until the vendor stops offering one and refuses rather than truncates when it cannot.
 *
 * THE API KEY NEVER LEAVES THIS FILE. It arrives as {@link createComposioClient}'s only argument,
 * goes straight into the vendor's constructor, and is held from there on by the vendor's client
 * inside a closure. Nothing below logs it, no thrown message quotes it, and neither of the two
 * returned objects carries a field that could be read back to it — they expose eight methods and
 * no state. A key in a log line is a key in a log aggregator, and a key in an error message is a
 * key in an audit row and in a model's context.
 */

/**
 * One catalogue row as the vendor hands it over, which is the wire's own spelling and nobody's map.
 *
 * `meta` is where all of it lives and every field of it is optional, which is not the SDK being
 * cautious: Composio genuinely publishes toolkits with no logo, no description and no category.
 * See {@link ComposioBroker.listApps} below for what each absence becomes.
 *
 * SNAKE_CASE AND `unknown` THROUGHOUT, BECAUSE THE TRANSFORMER THIS WAS WRITTEN AGAINST IS GONE.
 * The catalogue reads `client.toolkits.list` directly — see {@link ComposioVendor} for why it has
 * to — so `transformToolkitListResponse` no longer stands between Composio and {@link appOf}, and
 * three things it was doing have to be accounted for rather than assumed.
 *
 * IT RENAMED, so the count is `tools_count` here and the category's own word is `name`
 * (`@composio/client` 0.1.0-alpha.76, `resources/toolkits.d.ts:405-435`). That rename was the one
 * thing in this projection easiest to get silently wrong — a count read off the wrong key is a
 * plausible zero rather than an error — which is why {@link appOf} is where it is read and why a
 * test asserts the figure rather than the field.
 *
 * IT REBUILT `meta` AND THE `categories` LIST, spreading each into a fresh literal and mapping
 * every entry (`@composio/core` 0.18.1, `src/utils/transformers/toolkits.ts:21-34`). Those were
 * this file's two structural guarantees and they were real: a `meta` of null and a `categories` of
 * "crm" each raised a `TypeError` from that line when 0.18.1 was run, which is why neither was
 * declared `unknown` and neither was checked. Nothing raises now. A `meta` that is a string reads
 * as an app with no description, no logo, no categories and no count, and a `categories` that is a
 * string reads as an app in no category — two silent, plausible answers about a real app. Both are
 * declared at what the wire can hold and both are refused in {@link appOf}.
 *
 * AND IT NEVER VALIDATED, which is the part that does not change. `transform()` checks with
 * `safeParse` and, where that fails, logs a warning and returns the unvalidated object anyway
 * (`src/utils/transform.ts:26-36`), so `ToolKitItemSchema` spelling `name` required and the count a
 * number always described the answer Composio MEANS to send rather than the one that arrived. Every
 * wire-valued field was already `unknown` on that argument and stays so: the slug, which is the
 * only name this deployment has for an app; the name, which is the only thing to show a person
 * choosing between apps; the description, the logo, each category's word, and the count.
 */
type VendorToolkit = {
  slug?: unknown;
  name?: unknown;
  meta?: unknown;
  no_auth?: unknown;
  auth_schemes?: unknown;
  composio_managed_auth_schemes?: unknown;
};

/*
 * WHERE THE LINE BETWEEN "READ AT ITS TYPE" AND "READ OUT OF `unknown`" IS DRAWN, AND WHY IT MOVED.
 *
 * Everything below used to be read out of `unknown` — containers and fields alike — on one argument:
 * `transform()` validates with `safeParse`, logs a warning where it fails, and returns the
 * unvalidated object anyway (`@composio/core` 0.18.1, `src/utils/transform.ts:26-36`), so a
 * TypeScript declaration over a wire value is an assertion and not a check.
 *
 * THAT ARGUMENT IS TRUE OF THE FIELDS AND FALSE OF THE SHAPES AROUND THEM, which a round of running
 * the SDK against malformed answers established rather than reasoned about. `transform()` returns
 * whatever its TRANSFORMER built, and every one of these transformers builds its result by
 * dereferencing the raw answer — `response.items.map(...)`, `item.meta.categories`,
 * `authConfig.toolkit.logo`, `response.auth_config.id`. So the containers and the rows inside them
 * are the vendor's own construction and cannot arrive malformed; only the values copied ACROSS
 * those lines can, and those are exactly the fields declared `unknown` above. Guards were written
 * for both halves, and the ones covering the shapes were branches no answer could reach, standing
 * where the next reader would take them for what was keeping them safe.
 *
 * WHAT KEEPS THEM SAFE IS `askVendor`. A shape the SDK could not read raises inside the SDK, and
 * the `TypeError` row in {@link vendorRefusal} turns that into a sentence — one guard, at the layer
 * where the fault actually surfaces, covering every shape rather than the four somebody listed.
 *
 * REFUSING RATHER THAN FILLING IN, WHICH IS THE WHOLE OF THE ARGUMENT FOR THE FIELDS. A `?? ""`, a
 * `String(x)` or a cast does not make a malformed answer safe; it converts a fault this deployment
 * could have reported into an answer it gives wrongly, and the wrong answers are not small ones —
 * an app with no name in an administrator's picker, an action with no slug put in front of a model,
 * and the one that was actually happening: a delete sent with `undefined` where an account id belongs,
 * answered by Composio however it likes, after which the audit trail records that a person's access
 * was withdrawn and nothing had been. Every reader below therefore answers null on anything it
 * cannot read, and every caller turns that null into a sentence naming what Composio sent.
 */

/**
 * The remedy every shape refusal here ends with, because it is the same act in every one of them.
 *
 * None of these is a misconfiguration. The key is right, the request is right and the answer
 * arrived; what changed is the shape of it, which is a thing nobody operating this deployment can
 * correct from any page it has. Saying so is the difference between an operator reading their own
 * settings for an hour and an operator upgrading a package.
 */
const VENDOR_SHAPE_REMEDY =
  "That is a change in what Composio answers rather than a setting an operator can correct, so upgrading this deployment's @composio/core is what fixes it.";

/**
 * WHAT COMPOSIO PUT SOMEWHERE, NAMED IN A SENTENCE A READER CAN ACT ON.
 *
 * Every refusal below says what arrived where something else belonged, because "Composio's answer
 * was not a shape this deployment reads" sends whoever is holding the page looking through a vendor
 * dashboard with nothing to look for.
 *
 * THE VALUE IS NEVER QUOTED, AND THAT IS THE POINT OF THE FUNCTION RATHER THAN AN INTERPOLATION. A
 * listing row carries a person's mailbox address, an account handle and whatever else the vendor
 * chose to put on it, and a refusal from here is read off an admin page, written into an app's
 * `lastError` and put in front of a model. The shape is the part that is safe to say and is also
 * the only part that helps: a reader who knows a list arrived where an object belongs knows which
 * vendor change they are looking at.
 *
 * AND THE EMPTINESS IT REPORTS IS THE ONE THE CALLER JUDGED, WHICH IT WAS NOT. Every caller reaches
 * this function on the branch {@link textOf} sent it down, and `textOf` decides on the TRIMMED
 * value while this tested `value === ""` — so a padded blank, which is the shape a wire value
 * actually arrives in, was refused for being empty and then described as "a string". "Composio sent
 * a string where the id belongs" is a sentence with no finding in it: a string is what an id IS, so
 * the reader is told the field was right and the call refused anyway. The two branches now agree on
 * what blank means, and they say which of the two blanks arrived, because an id that is three
 * spaces and an id that is absent are different things to go looking at in a dashboard.
 */
function sent(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") {
    if (value === "") return "an empty string";
    return value.trim() === "" ? "a string of blank space" : "a string";
  }
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/*
 * THE CONTAINER OF A LISTING IS THE ONE THING BELOW THAT IS NOT READ OUT OF `unknown`, AND THE
 * REASON IS THAT THE SDK PROVES IT.
 *
 * There used to be a `hasFields` predicate and an `itemsOf` reader here, and every listing passed
 * its answer through them before touching a field — on the argument the row types give at length,
 * that a TypeScript interface over a wire value is an assertion rather than a check. That argument
 * is correct about the FIELDS and wrong about the CONTAINER, which running `@composio/core` 0.18.1
 * settles rather than reasons about. Every list transformer dereferences the answer before
 * returning it: `response.items.map(...)` in `transformAuthConfigListResponse`
 * (`src/utils/transformers/authConfigs.ts:79`), in `transformConnectedAccountListResponse`
 * (`connectedAccounts.ts:113`). So a container of the wrong shape — null, a bare list where an
 * envelope belongs, an `items` that is a string — dies inside the vendor's code and NEVER arrives
 * here. Each of those guards was therefore a branch no input could reach, sitting where the next
 * reader would take it for the thing keeping them safe.
 *
 * WHAT KEEPS THEM SAFE IS ONE LAYER DOWN NOW. The vendor's crash is a bare `TypeError`, and
 * {@link vendorRefusal} translates it into a sentence naming what did not happen and the one act
 * that changes it — which catches every malformed container, including the shapes nobody here
 * thought to enumerate.
 *
 * AND IT IS TWO OF THE FOUR LISTINGS NOW RATHER THAN ALL OF THEM, WHICH IS THE COST OF PAGING THE
 * OTHER TWO. The catalogue and the action listing read `@composio/client` directly — a generated
 * client that parses the body and returns it — so nothing dereferences their answers before this
 * file does. The same two shapes therefore reach this code rather than dying in the vendor's, and
 * {@link pageOf} answers them at exactly those two call sites. The argument above still holds
 * everywhere it is made: a guard is written where an input can reach it and nowhere else.
 *
 * SO THE DECLARATIONS BELOW ARE READ AT THEIR TYPES, and each one says which vendor line makes it
 * true. The fields inside them stay `unknown`, because the warn-only `transform()` really does copy
 * those across whatever they turn out to be.
 */

/**
 * One field as the non-empty string it has to be, or null where the vendor sent anything else.
 *
 * EMPTY COUNTS AS ABSENT because every caller of this reads an identifier — a slug, an id, a name
 * this file matches a suffix against — and an empty identifier is unusable in exactly the way a
 * missing one is, while being the one that reads as present at every glance.
 *
 * AND THE STRING THAT COMES BACK IS THE ONE THAT WAS JUDGED, which it was not. This decided
 * emptiness on the TRIMMED value and answered the PADDED one, so " " was correctly refused while
 * " ac_1 " was accepted and handed on with its spaces — a guard that checked one thing and passed
 * along another. What that reached is the whole of this file: a padded id is what an auth-config
 * delete and an account withdrawal NAME, so Composio is asked to remove an object nobody has;
 * a padded slug is what an enabled app records into its url and what an action list writes into
 * `mcp_tools`; and a padded app slug on the vendor's own answer compares unequal to the app the
 * caller was gated on, refusing a call that was about the right app the whole time. Trimming is
 * not tidying here — it is answering with the identifier rather than with the identifier plus
 * whatever the wire wrapped it in.
 */
function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * Where each field scheme sits in the order a person would rather meet them.
 *
 * A RECORD KEYED BY {@link FieldScheme} RATHER THAN A LIST OF THEM, because the compiler counts the
 * keys of a record and counts nothing at all about a list. This was a `readonly FieldScheme[]`
 * spelling the same four names a second time, which is precisely what the comment on
 * {@link FIELD_SCHEME_NAMES} argues against: the same set stated twice, where a member added to one
 * of them and not the other typechecks perfectly. An element type refuses a name that is not a
 * scheme and says nothing whatever about a scheme left out.
 *
 * AND THE ONE LEFT OUT FAILS OPEN, MORE QUIETLY HERE THAN THERE. A fifth scheme added to the names
 * and not given a rank here would match nothing in the pick below, so every app publishing it would
 * fall through to `unsupported` — and the directory route hides an unsupported app, so those apps
 * would simply leave the picker: no refusal for anyone to read, no operator sentence, and no failing
 * test. `Record<FieldScheme, number>` does not compile until the new scheme has a place, which is
 * the whole of the protection, and the reason the pick goes through {@link isFieldScheme} rather
 * than through a second list of names.
 *
 * THE ORDER ITSELF IS THE PERSON'S AND NOT THE WIRE'S, and it is unchanged: a plain key first,
 * because it is the one they are likeliest to already hold, then the other three ways of spelling a
 * secret they have to go and assemble.
 *
 * `CUSTOM_CREDENTIAL` HAS A PLACE HERE AND CAN NEVER BE MET HERE. It is OpenConnector's member of
 * {@link FieldScheme} — Composio never publishes it, and this order ranks nothing but what Composio
 * publishes — so the position exists only because the record refuses to compile until every member
 * has one, and it sits last so it makes no claim about where a set of fields somebody already holds
 * would rank among the schemes a person has to go and assemble.
 */
const FIELD_SCHEME_ORDER: Record<FieldScheme, number> = {
  API_KEY: 0,
  BEARER_TOKEN: 1,
  BASIC: 2,
  BASIC_WITH_JWT: 3,
  CUSTOM_CREDENTIAL: 4,
};

/**
 * The schemes a managed config can actually send somebody to a page for, as the VENDOR names them.
 *
 * WHICH IS THE WHOLE OF WHAT `consent` CLAIMS. That kind means one thing below: create a
 * `use_composio_managed_auth` config and mint a link the person visits. Composio publishes the set
 * of schemes a link exists for and calls it exactly that — `RedirectableAuthSchemeSchema` is
 * `z.enum([OAUTH1, OAUTH2])` (`@composio/core` 0.18.1,
 * `src/types/connectedAccountAuthStates.types.ts:15-18`) — so a managed scheme outside it has no
 * page to send anybody to, whatever else is true of it.
 *
 * `DCR_OAUTH` IS NOT HERE AND IS NOT AN OMISSION. The vendor leaves it out of that enum and this
 * file drives it through its own kind — `self-registering`, a CUSTOM config whose client registers
 * itself at connect time — so it is read off {@link VendorToolkit.auth_schemes} below rather than
 * off the managed list.
 */
const REDIRECTING_SCHEMES = ["OAUTH2", "OAUTH1"];

/**
 * The scheme Composio publishes for an app that asks nobody for anything.
 *
 * THE FLAG AND THE SCHEME ARE TWO SPELLINGS OF ONE FACT, and only the second is guaranteed. A
 * toolkit needing no authentication publishes `NO_AUTH` among its schemes; `no_auth` is an
 * additional boolean the catalogue MAY carry, and `ToolKitItemSchema` spells it optional. Reading
 * only the flag made an app that published the scheme without it `unsupported` — whose sentence
 * claims the app wants an OAuth application registered here, which is the opposite of true — and
 * `routes.ts` then hid the app from the picker over it.
 */
const NO_AUTH_SCHEME = "NO_AUTH";

/**
 * The words out of an `unknown`, which is all a vendor list promises — and a refusal for the rest.
 *
 * ABSENT IS AN ANSWER AND UNREADABLE IS NOT, WHICH IS THE WHOLE OF THE CORRECTION. Composio
 * genuinely lists toolkits with no scheme beside them at all, and {@link connectionOf} reads that
 * as an app nothing here can connect — a true thing to say about a real row. This used to answer
 * the same empty list for an `auth_schemes` that arrived as a string, and for a list one of whose
 * members was not a word: the unreadable answer and the honest absence became the same sentence,
 * and an unsupported app is HIDDEN from the picker, so the one nobody could act on was also the one
 * nobody could see. On the managed list it is louder still — an app whose consent screen would have
 * asked a person for nothing drops a rank and starts asking them to go and find a key.
 *
 * A MEMBER IS GUARDED AS HARD AS THE LIST, because dropping the ones that are not words leaves a
 * shorter list that reads exactly like a shorter list the app published, and the decision below is
 * made on which words are in it.
 *
 * AND THE WORD IS THE TRIMMED ONE, WHICH IS WHY THE MEMBER GOES THROUGH {@link textOf}. A scheme is
 * the NAME of a flow: it is compared against the literals below and recorded on the app's row when
 * somebody enables it, so a padded `" OAUTH2 "` is the app's own scheme wearing whatever the wire
 * wrapped it in, and `"  "` is the one unusable value that reads as present at every glance.
 *
 * `where` IS THE NOUN PHRASE THE SENTENCE IS BUILT AROUND, so the two call sites differ in the one
 * thing that differs between them: which of an app's two scheme lists could not be read.
 */
function labelsOf(value: unknown, where: string): string[] {
  const listed = value ?? [];
  if (!Array.isArray(listed)) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(value)} where ${where} belong. This deployment reads that list to decide which flow the app gets, and an app that publishes no scheme at all is ordinary and shows as one nothing here can connect — so a list that is not a list would show as that same app, missing from the picker for a reason nobody could act on. ${VENDOR_SHAPE_REMEDY}`,
    );
  }
  return listed.map((entry: unknown, index: number) => {
    const scheme = textOf(entry);
    if (scheme === null) {
      throw new BrokerRefusalError(
        `Composio sent ${sent(entry)} where scheme ${index + 1} of ${where} belongs, and a scheme is the word this deployment matches against the flows it knows how to run. Leaving out the ones that are not words makes a shorter list, which reads exactly like a shorter list the app published. ${VENDOR_SHAPE_REMEDY}`,
      );
    }
    return scheme;
  });
}

/**
 * Which flow an app gets, and why that order.
 *
 * NO AUTHENTICATION FIRST, AND IT IS NOT A PREFERENCE. Composio refuses an auth config for such a
 * toolkit outright — "Cannot create an auth config for toolkit hackernews because it does not
 * require authentication" — so an app that says so has no other reading available, whatever else it
 * publishes beside it. It says so in either of two places; see {@link NO_AUTH_SCHEME}.
 *
 * Then managed OAuth, because it asks the person for nothing at all — and MANAGED OAUTH IS READ
 * RATHER THAN COUNTED, which is the difference between a consent and a dead end. This tested the
 * LENGTH of the managed list, so a list holding any word at all became `consent`: the app got a
 * Composio-managed config and a person got sent to a link mint for a scheme with no page behind it.
 * {@link REDIRECTING_SCHEMES} is the vendor's own answer to which words have one.
 *
 * Then self-registering OAuth, which asks nobody for anything: the client registers itself at
 * consent time. Then a scheme whose secret the person already holds. What is left wants an OAuth
 * client registered by whoever runs this deployment, and there is nowhere here to put one, so it is
 * named rather than attempted.
 *
 * AND "UNSUPPORTED" IS A VERDICT RATHER THAN A PLACE TO PUT WHAT COULD NOT BE READ. `routes.ts`
 * hides an unsupported app from the picker, and the enable route answers its `reason` — so a row
 * whose shape this file could not read used to leave the catalogue silently, under a sentence
 * telling an administrator the app wants an OAuth application when nothing here had established
 * that. Every unreadable shape now refuses, which stops the whole catalogue for the reason
 * {@link appOf} gives at length: one refusal an operator can act on is worth more than several
 * hundred rows, one of which is a guess.
 */
export function connectionOf(row: VendorToolkit): BrokerConnection {
  /*
   * THE APP IS NAMED OFF THE ROW RATHER THAN HANDED IN, because a refusal out of {@link labelsOf}
   * travels up through {@link appOf} and onto an operator's page, where "this app" is a sentence
   * with nothing to look for in it. {@link appOf} refuses a row with no readable slug before it
   * reaches here, so the fallback is for the one caller that is a test.
   */
  const at = textOf(row.slug) ?? "this app";
  const offered = labelsOf(
    row.auth_schemes,
    `the authentication schemes ${at} offers`,
  );
  const managed = labelsOf(
    row.composio_managed_auth_schemes,
    `the authentication schemes Composio holds ${at}'s own credentials for`,
  );

  /*
   * AND A FLAG THIS FILE CANNOT READ IS NOT THE SAME AS ONE THE APP DOES NOT PUBLISH. Most rows
   * carry no `no_auth` at all and reading that as "this app needs authenticating" is the right
   * answer, which is what {@link flagOf}'s default keeps — and the scheme list below carries the
   * same fact for every toolkit that publishes it. A `no_auth` that is PRESENT and is not a
   * boolean has no such reading: `"true" === true` is false, so the vendor saying an app needs
   * nothing arrived at the very check that acts on it as the vendor having said nothing — and the
   * app is then enabled down a path Composio refuses outright ("Cannot create an auth config for
   * toolkit hackernews because it does not require authentication"), or a person is sent to a form
   * for a credential the app has no use for.
   */
  const flagged = flagOf(row.no_auth, false);
  if (flagged === null) {
    throw new BrokerRefusalError(
      `Composio sent ${sent(row.no_auth)} where its flag saying whether ${at} needs authenticating at all belongs, and that one field decides the whole of the flow: an app flagged this way is one Composio REFUSES an authorization config for, whatever else it publishes beside the flag. A value this deployment cannot read is not the app's silence on the question, so it is not read as one. ${VENDOR_SHAPE_REMEDY}`,
    );
  }

  if (flagged || offered.includes(NO_AUTH_SCHEME)) return { kind: "no-auth" };

  if (managed.some((scheme) => REDIRECTING_SCHEMES.includes(scheme))) {
    return { kind: "consent" };
  }
  if (offered.includes("DCR_OAUTH")) return { kind: "self-registering" };

  const field = offered
    .filter((scheme) => isFieldScheme(scheme))
    .sort(
      (left, right) => FIELD_SCHEME_ORDER[left] - FIELD_SCHEME_ORDER[right],
    )[0];
  if (field) return { kind: "fields", authScheme: field };

  /*
   * THE SENTENCE NAMES WHAT WAS ACTUALLY PUBLISHED, INCLUDING THE MANAGED WORDS NOTHING ELSE READS.
   * A managed list of schemes that do not redirect is now the commonest way to reach this branch,
   * and a reason built from `auth_schemes` alone would tell an administrator the app published
   * nothing — about a row that published something this deployment simply cannot drive.
   */
  const published = [...new Set([...offered, ...managed])];
  return {
    kind: "unsupported",
    reason: published.length
      ? `${published.join(", ")} needs an OAuth application registered by whoever runs this deployment, and this deployment holds no place to put its own OAuth client for a brokered app.`
      : "Composio published no authentication scheme for this app, so there is no flow this deployment could run, and its own OAuth client is not something this deployment can register.",
  };
}

/**
 * What this adapter needs of `@composio/core`'s client, written as a shape rather than as a class.
 *
 * A TEST SATISFIES IT WITH AN OBJECT LITERAL, which is the entire argument for it and the reason
 * {@link buildComposioClient} takes one of these instead of an API key. The vendor's own client
 * cannot be constructed without a key and answers nothing without a network, so an adapter that
 * built its own client would be an adapter no test could reach — and this is the file where the
 * field names, the argument order and the refusal below would go wrong unnoticed.
 *
 * Every member is written with METHOD syntax deliberately. Method parameters are compared
 * bivariantly, so a real `Composio` — whose signatures carry optional request-options arguments
 * and wider parameter types than the calls here use — satisfies this without a cast.
 *
 * THE TWO DELETES ARE NOT `Composio`'s, AND THAT IS THE ONE PLACE THIS SHAPE DIVERGES FROM IT. Both
 * of the vendor's own wrappers hard-code the request body they send — `this.client.authConfigs
 * .delete(nanoid, undefined, requestOptions)` and the same line for connected accounts
 * (`@composio/core` 0.18.1, `src/models/AuthConfigs.ts:303-311` and
 * `src/models/ConnectedAccounts.ts:532-540`) — so through them the `revoke_on_delete` parameter
 * cannot be passed at all, and both calls soft-delete while the grant at Google or Slack stands. So
 * the shape below asks for the underlying client's signature instead, and
 * {@link createComposioClient} satisfies it from `composio.getClient()`. See
 * {@link ComposioBroker.revoke} for what that flag is and what its absence made this deployment
 * claim.
 */

/**
 * Both seams, over one vendor client.
 *
 * TAKING THE VENDOR OBJECT RATHER THAN A KEY IS THE SEAM. It is what lets every test of this
 * file's own decisions — which limit went out, which field became which, which call was refused
 * before it was made — run against an object literal and never a socket. {@link createComposioClient}
 * is the one line that turns a key into a vendor, and it is deliberately too thin to have a bug in.
 *
 * The vendor is captured in a closure rather than stored on either returned object, so neither
 * `actions` nor `broker` offers a route back to the client or to the key it holds.
 *
 * @param now The clock the catalogue's lifetime is measured against, injected for the same reason
 * the vendor is. A test that could not move the clock could only assert the cache's hit by counting
 * calls and would have to sleep ten minutes to assert its expiry, so the window would be the one
 * thing here no test could reach. It is a parameter of the builder rather than of
 * {@link ComposioBroker.listApps}, because the seam's callers are routes and none of them has an
 * opinion about what time it is.
 */
export function buildComposioClient(
  vendor: ComposioVendor,
  now: () => number = Date.now,
): {
  actions: ComposioActions;
  broker: ConnectedAppBroker;
} {
  const context = createClientContext(vendor, now);
  const actions = actionsFor(context);

  const broker: ComposioBroker = {
    ...directoryMethods(context),
    ...consentMethods(context),
    ...fieldMethods(context),
    ...accountMethods(context),
  };
  return { actions, broker };
}

/**
 * The lines that turn this deployment's API key into a vendor client.
 *
 * Most of what this file decides lives in {@link buildComposioClient}, and this one used to say it
 * therefore had "no decision worth testing". That sentence was wrong twice over and both times in
 * the same way: this is where the SDK's DEFAULTS are accepted or refused, and a default accepted by
 * omission looks exactly like a default nobody thought about. It cost the two deletes their
 * `revoke_on_delete` once — see the describe about which delete the vendor carries — and it left
 * the construction literal below unpinned, so that deleting a line from it phoned out on boot and
 * broke no test. Both are now asserted; the construction literal carries its own note.
 *
 * The key is a parameter here and a private field of the vendor's client thereafter, and no path
 * out of this module carries it — see the module comment. That is also why this returns the seam
 * rather than the vendor: handing `composio` back would put the key on an object any caller could
 * read, so the construction below is asserted by what it DOES, not by a config object a test could
 * inspect.
 *
 * IT IS NO LONGER ONE LINE, AND THE REASON WAS THE TWO DELETES AND IS NOW ALSO THE TWO LISTINGS.
 * `Composio` used to satisfy {@link ComposioVendor} whole, passed straight in. It cannot any more,
 * for two separate faults in the same wrapper. Its own `authConfigs.delete` and
 * `connectedAccounts.delete` send a hard-coded empty body and therefore cannot ask for the upstream
 * revocation, which is the difference between ending somebody's access and filing it away. And its
 * `tools.getRawComposioTools` and `toolkits.get` cannot be paged — one takes no cursor, the other
 * drops the response's — which is the difference between a catalogue and the first thousand rows
 * of one, and which showed an operator an empty app picker. The underlying `@composio/client`
 * answers all four, so those members are satisfied from `getClient()` and the rest from the SDK's
 * own models. A wrapper per member rather than a spread, so that the arrow's own type checks
 * against the shape above — a vendor method whose signature drifted would fail here rather than at
 * the call site.
 *
 * NO NEW IMPORT, WHICH IS WHY THE ONE-IMPORT-SITE RULE SURVIVES THIS. `getClient()` is public on the
 * SDK's own object and the client's types are inferred from it; `@composio/client` is not named
 * anywhere under `server/src`, so a version bump still has exactly this file to be read against.
 */
export function createComposioClient(apiKey: string): {
  actions: ComposioActions;
  broker: ConnectedAppBroker;
} {
  /*
   * THREE ENTRIES, EVERY ONE OF THEM LOAD-BEARING, AND ALL THREE PINNED BY A TEST. What this
   * literal settles is what a boot of this server is allowed to do before it has served anything:
   * which host the key goes to, whether a third party hears about the start-up, and whether a
   * vendor library gets a say in how the process shuts down. Those are deployment facts, not
   * style, and none of them was visible to a test until one was written for them — see
   * `server/tests/composio-adapter.test.ts`, "what constructing the vendor is allowed to do on
   * boot", which watches a stubbed transport and a stubbed `process.on` and fails if any line here
   * is deleted or flipped. Read that test before changing anything below.
   *
   * `apiKey` DOES NOT FAIL WHEN DROPPED, IT FALLS BACK. `getSDKConfig` reads `COMPOSIO_API_KEY`
   * out of the environment and then `api_key` out of `~/.composio/user_data.json`
   * (`@composio/core` 0.18.1, `src/utils/sdk.ts:42-52`), so a literal that lost this line would go
   * on working against whichever account the machine was last logged into, with the configured
   * `config.composioApiKey` silently unused. `baseURL` is deliberately NOT passed for the same
   * reason read the other way: the default is `https://backend.composio.dev`
   * (`src/utils/constants.ts:7`), and the test asserts the origin every request actually goes to,
   * so adding one here is a change that has to be argued for rather than one that slips in.
   */
  const composio = new Composio({
    apiKey,
    /*
     * TRACKING OFF DOES TWO THINGS, AND THE SECOND IS THE ONE THAT IS HARD TO UNDO. It defaults to
     * TRUE (`src/utils/config-defaults/ConfigDefaults.node.ts:5`), and a true value runs
     * `telemetry.setup()` (`src/composio.ts:380-390`). That POSTs an `SDK_INITIALIZED` metric to
     * `https://telemetry.composio.dev/v1/metrics/invocations`
     * (`src/services/telemetry/TelemetryService.ts:4,38-46`) — a third party's analytics, which
     * the operator of a self-hosted install never opted into. And, before that, it installs THREE
     * process-level listeners — `beforeExit`, `SIGINT` and `SIGTERM`
     * (`src/telemetry/Telemetry.ts:66,315-356`) — whose signal handlers flush telemetry, then
     * `removeListener` and `process.kill(process.pid, signal)` to re-raise. Blocking the egress
     * would not undo that half: it would leave a vendor library between an operator's Ctrl-C, or a
     * container runtime's SIGTERM, and this server's exit.
     */
    allowTracking: false,
    /*
     * AND THE BOOT MUST NOT DEPEND ON THE VENDOR'S RELEASE FEED. This defaults to FALSE
     * (`src/composio.ts:113-120`), and a falsy value runs `checkForLatestVersionFromNPM`
     * (`src/composio.ts:399-402`), which fetches `https://registry.npmjs.org/@composio/core/latest`
     * (`src/utils/version.ts:41-43`) as the client is constructed.
     */
    disableVersionCheck: true,
    /*
     * NOTHING ELSE IS PASSED, AND THE REST OF `ComposioConfig` IS ACCEPTED AS IT COMES, which is
     * safe only because of where each default lands — recorded here so the next reader does not
     * have to re-derive it.
     *
     * `dangerouslyAllowAutoUploadDownloadFiles` defaults OFF (`ConfigDefaults.node.ts:4`) and is
     * the premise `./composio`'s file filter is written on; that filter drops every action whose
     * schema stages a file under EITHER setting, so the premise is defended by a tested guard
     * rather than by this literal, and turning the flag on here would be a change to make against
     * that filter. `sensitiveFileUploadProtection`, `fileUploadPathDenySegments`, `fileUploadDirs`
     * and `fileDownloadDir` only bear on uploads and downloads that the same filter means never
     * happen. `provider` defaults to the SDK's `OpenAIProvider`, which this adapter never asks to
     * format anything — every read here goes through the raw client or the SDK's own models.
     * `host` and `defaultHeaders` are telemetry and header cosmetics, and telemetry is off above.
     * `toolkitVersions` defaults to "latest", which is the literal every listing in this file
     * already passes explicitly; see {@link ComposioVendor.tools.list}.
     */
  });
  const client = composio.getClient();

  return buildComposioClient({
    tools: {
      // The listing is the raw client's because the wrapper has no cursor; the single-tool read and
      // the execute stay the SDK's, because both are one call about one action and neither pages.
      list: (query) => client.tools.list(query),
      getRawComposioToolBySlug: (slug, options) =>
        composio.tools.getRawComposioToolBySlug(slug, options),
      execute: (slug, body) => composio.tools.execute(slug, body),
    },
    toolkits: {
      list: (query) => client.toolkits.list(query),
      retrieve: (slug) => client.toolkits.retrieve(slug),
    },
    authConfigs: {
      list: (query) => composio.authConfigs.list(query),
      /*
       * THE SCHEME TYPE IS THIS DEPLOYMENT'S AND THE ENUM IS THE VENDOR'S, AND THE TWO PARTED
       * COMPANY WHEN `CUSTOM_CREDENTIAL` JOINED {@link FieldScheme}. That member is OpenConnector's:
       * Composio never publishes it, the pick above can only choose from what Composio's own
       * catalogue offered, and the OpenConnector broker creates no config at all — so a value the
       * vendor's enum refuses cannot reach this call. The widening is spent here, at the one line
       * where this deployment's projection meets the vendor's schema, exactly as `state` is below.
       */
      create: (toolkit, options) =>
        composio.authConfigs.create(
          toolkit,
          options as Parameters<typeof composio.authConfigs.create>[1],
        ),
      delete: (id, params) => client.authConfigs.delete(id, params),
    },
    connectedAccounts: {
      list: (query) => composio.connectedAccounts.list(query),
      link: (userId, authConfigId, options) =>
        composio.connectedAccounts.link(userId, authConfigId, options),
      /*
       * The create is the raw client's for a third reason of its own: the SDK's wrapper over this
       * endpoint is `initiate`, which is retired for the managed-auth path, and `link` above — its
       * replacement — mints a consent url and has nowhere to put a value a person typed.
       *
       * THE ONE ASSERTION IN THIS FUNCTION, AND IT IS ABOUT `state` ALONE. The generated client
       * declares that field as a fourteen-member union keyed on the scheme, each member's `val`
       * ending in `[k: string]: unknown` — which is to say the vendor's own type admits any object
       * once the scheme is picked, and picking it here would be this file asserting which boxes an
       * app asks a person for. {@link ComposioVendor} therefore says `unknown` and the widening is
       * spent here, at the one line where this deployment's projection meets the vendor's schema
       * and nothing else is decided.
       */
      create: (body) =>
        client.connectedAccounts.create(
          body as Parameters<typeof client.connectedAccounts.create>[0],
        ),
      delete: (id, params) => client.connectedAccounts.delete(id, params),
    },
  });
}
