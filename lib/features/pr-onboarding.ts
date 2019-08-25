import { PRContext, sentByThisApp } from "../models/context";
import { hasReleaseLabels } from "../models/release";
import { Config, getConfig } from "../models/config";
import dedent from "dedent";
import { createChecklist, parseChecklists, ChecklistItem, moreThanOneItemChecked } from "../models/checklist";
import {
  renderLabel,
  populateLabel,
  getSkipReleaseLabelsFromConfig,
  findLabelFromHash,
  addLabelsToPR,
  removeLabelsFromPR,
  getLabelsOnPR,
  labelToString,
} from "../models/label";
import { sub, italics, bold } from "../utils/markdown";
import { WebhookPayloadPullRequest } from "@octokit/webhooks";
import { Context, Application } from "probot";
import { getLabelRelease } from "../models/release";
import { getLogger } from "../utils/logger";
import { isString, isEqual } from "lodash";
import { hash } from "../utils/hash";
import to from "await-to-js";

const logger = getLogger("pr-onboarding");

const CHECKLIST_NAMESPACE = "autobot";

enum ChecklistKey {
  semver = "semver",
  skipRelease = "skipRelease",
}

/**
 * A shorthanded way of creating a checklist in the `autobot` namespace
 */
const createAutoChecklist = createChecklist.bind(null, CHECKLIST_NAMESPACE);

/**
 * A shorthanded method of grabbing only checklist items in the `autobot` namespace
 * @param body The text content of a PR description
 */
const parseAutoChecklists = (body: string) => parseChecklists(body, CHECKLIST_NAMESPACE);

const MessageStart = "<!--- AutoPR:START --->";
const MessageEnd = "<!--- AutoPR:END --->";

export const messageWrapper = (body: string) => dedent`
    ${MessageStart} 
    ---

    ${body}

    <sub>_Generated by [auto-it](https://github.com/apps/auto-it)_</sub>
    ${MessageEnd} 
`;

export const onBoardingMessage = (sections: string[]) => dedent`
    <img align="left" width="60" src="https://autobot.auto-it.now.sh/public/logo.png"/>

    ### Choose a release label

    This repository uses [auto](https://github.com/intuit/auto) to generate releases. In order to do that, 
    it needs an appropriate label assigned to each PR. Choose a label below that you feel best suites your changes.

    ${sections.join("\n\n")}
  `;

const collapsedOnBoardingMessage = (sections: string[]) => dedent`
  <details>
  <summary><b>Choose a release label</b></summary>

  &nbsp;
  <img align="left" width="60" src="https://autobot.auto-it.now.sh/public/logo.png"/> This repository uses [auto](https://github.com/intuit/auto) to generate releases. In order to do that, it needs an appropriate label assigned to each PR. Choose a label below that you feel best suites your changes. 

  ${sections.join("\n\n")}

  </details>
`;

const parseMessage = (body: string) => body.split(MessageStart)[1].split(MessageEnd)[0];

const overwriteMessage = (context: PRContext, content: string) => {
  const { body } = context.payload.pull_request;
  const [start, bottomHalf] = body.split(MessageStart);
  const [, end] = bottomHalf.split(MessageEnd);
  return start + messageWrapper(content) + end;
};

const sectionHeader = (text: string, secondaryText?: string, info?: string) =>
  sub(`${bold(text)}${secondaryText ? ` ${italics(secondaryText)}` : ""}`);

const semverHead = sectionHeader("Semver Labels", "(choose one at most)");
const skipReleaseHead = sectionHeader("Skip Release Labels");

const section = (header: string, checklist: string, warning?: string) => dedent`
    ##

    ${header}
    
    ${checklist}
    ${warning ? "\n" + sub(":warning: " + italics(bold(warning))) : ""}
    `;

/**
 * Creates the checklist markdown given the current state of the PR and optionally which labels are on a PR.
 * If the checklist was already present, it takes the past state of the checklist into account.
 *
 * @param useLabels Whether labels present on the PR should be used in determining which items are checked
 */
const createLabelChecklists = async (context: PRContext, config: Config, useLabels = false) => {
  // Fetch labels from config
  const { owner, repo } = context.repo();
  const { data: labels } = await context.github.issues.listLabelsForRepo({ owner, repo });
  let prLabels: string[] = [];

  if (useLabels) {
    prLabels = getLabelsOnPR(context).map(label => labelToString(label));
  }

  let checklists = parseAutoChecklists(context.payload.pull_request.body);

  const semverChecklistItems = await Promise.all(
    ["major", "minor", "patch"].map(async labelType => {
      const label = await populateLabel(labelType, config.labels[labelType], context, labels);
      let checked = false;
      const labelId = hash(label.name);

      // If a checklist for this type already exists, correctly populate the checklist
      const semverChecklist = checklists[ChecklistKey.semver];
      if (!useLabels && semverChecklist) {
        const checklistItem = semverChecklist.items.find(({ id }) => id === labelId);
        checked = (checklistItem && checklistItem.checked) || false;
      }

      if (useLabels) {
        checked = prLabels.includes(label.name);
      }

      return {
        id: labelId,
        checked,
        body: renderLabel(label),
      };
    }),
  );
  const semverChecklist = createAutoChecklist(ChecklistKey.semver, semverChecklistItems);
  const semverWarnings = moreThanOneItemChecked(semverChecklistItems)
    ? "At most one semver label should be selected"
    : undefined;

  const skipReleaseChecklistItems = await Promise.all(
    getSkipReleaseLabelsFromConfig(config).map(async labelConfig => {
      const label = await populateLabel("skip-release", labelConfig, context, labels);
      let checked = false;
      const labelId = hash(label.name);

      // If a checklist for this type already exists, correctly populate the checklist
      const skipReleaseChecklist = checklists[ChecklistKey.skipRelease];
      if (!useLabels && skipReleaseChecklist) {
        const checklistItem = skipReleaseChecklist.items.find(({ id }) => id === labelId);
        checked = (checklistItem && checklistItem.checked) || false;
      }

      if (useLabels) {
        checked = prLabels.includes(label.name);
      }

      return {
        id: labelId,
        checked,
        body: renderLabel(label),
      };
    }),
  );
  const skipReleaseChecklist = createAutoChecklist(ChecklistKey.skipRelease, skipReleaseChecklistItems);
  const skipReleaseWarnings = moreThanOneItemChecked(skipReleaseChecklistItems)
    ? "At most one skip release label should be selected"
    : undefined;

  return [
    section(semverHead, semverChecklist, semverWarnings),
    section(skipReleaseHead, skipReleaseChecklist, skipReleaseWarnings),
  ];
};

export const isOnboarding = (context: PRContext) => {
  const { body } = context.payload.pull_request;
  return body.includes(MessageStart);
};

/**
 * `true` if there was a change to the body of the PR, `false` otherwise
 */
const didBodyChange = (context: PRContext) =>
  (context.payload.changes &&
    context.payload.changes.body &&
    isString(context.payload.changes.body!.from) &&
    !!context.payload.pull_request.body) ||
  false;

const getLabelTextFromChecklistItem = (checklistItem: ChecklistItem, config: Config) => {
  const label = findLabelFromHash(checklistItem.id, config);
  if (!label) {
    logger.debug("Couldn't match label with checklist item", { checklistItem });
  }
  return label;
};

/**
 * This method determines what labels need to be added or removed
 * based on the current state of labels and checkboxes in the PR.
 *
 * @param body A string containing the entire PR description
 * @param config The auto configuration object
 */
const getRequiredLabelChanges = (body: string, config: Config) => {
  const checklists = parseAutoChecklists(parseMessage(body));
  const checklistKeys = Object.values(ChecklistKey);

  const checklistItems = Object.values(checklists)
    .filter(checklist => checklistKeys.includes(checklist.id))
    .map(checklist => checklist.items)
    .reduce((a, b) => a.concat(b), []);

  const labelsToAdd = checklistItems
    .filter(checklist => checklist.checked)
    .map(checklist => getLabelTextFromChecklistItem(checklist, config))
    .filter(label => !!label) as string[];

  const labelsToRemove = checklistItems
    .filter(checklist => !checklist.checked)
    .map(checklistItem => getLabelTextFromChecklistItem(checklistItem, config))
    .filter(label => !!label) as string[];

  return {
    labelsToAdd,
    labelsToRemove,
  };
};

/**
 * Did the text of the PR Onboarding message inside the body change between updates?
 */
export const didMessageChange = (context: PRContext) => {
  if (!didBodyChange(context)) {
    logger.debug("No body changes");
    return false;
  }
  const newMessage = parseMessage(context.payload.pull_request.body);
  const oldMessage = parseMessage(context.payload.changes!.body!.from);
  if (newMessage == oldMessage) {
    logger.debug("Nothing changed in the message");
    return false;
  }
  logger.debug("message changed");
  return true;
};

export const didChecklistsChange = (newMessage: string, oldMessage: string) => {
  const checklistChanged = !isEqual(parseAutoChecklists(newMessage), parseAutoChecklists(oldMessage));
  logger.debug(checklistChanged ? "checklists changed" : "checklists did not change");
  return checklistChanged;
};

/**
 * This is the entry point of the PR Onboarding feature.
 */
export default (app: Application) => async (context: Context<WebhookPayloadPullRequest>) => {
  const { action, pull_request } = context.payload;
  const config = await getConfig(context);
  const release = getLabelRelease(context, config);
  const onBoarding = action !== "opened" && isOnboarding(context);

  // Just started on-boarding
  if (action === "opened" && hasReleaseLabels(release) === false) {
    logger.debug("Starting on-boarding flow");
    const { owner, repo, number: pull_number } = context.issue();
    const body = dedent`
      ${pull_request.body}
      
      ${messageWrapper(onBoardingMessage(await createLabelChecklists(context, config)))}
    `;

    context.github.pulls.update({
      owner,
      repo,
      pull_number,
      body,
    });

    // Updated after user changes
  } else if (onBoarding && action === "edited" && didMessageChange(context)) {
    logger.debug("starting edited flow");

    // Do nothing if this was just triggered from a previous update
    if (await sentByThisApp(app, context)) {
      logger.debug("Skipping edited event because update was sent by current app");
      return;
    }

    const { owner, repo, number: pull_number } = context.issue();
    const newMessage = onBoardingMessage(await createLabelChecklists(context, config));
    const body = overwriteMessage(context, newMessage);

    let addLabelsError, removeLabelsError;
    if (didChecklistsChange(newMessage, parseMessage(context.payload.changes!.body!.from))) {
      const { labelsToAdd, labelsToRemove } = getRequiredLabelChanges(body, config);
      [addLabelsError] = await to(addLabelsToPR(context, labelsToAdd));
      [removeLabelsError] = await to(removeLabelsFromPR(context, labelsToRemove));
    }

    const [updateBodyError] = await to(
      context.github.pulls.update({
        owner,
        repo,
        pull_number,
        body,
      }),
    );

    if (addLabelsError || removeLabelsError || updateBodyError) {
      addLabelsError && logger.error("Error when trying to add labels", addLabelsError);
      removeLabelsError && logger.error("Error when trying to remove labels", removeLabelsError);
      updateBodyError && logger.error("Error when trying to update the body", updateBodyError);
      throw new Error("Encountered issue after checklist edit, see log above for details");
    }

    // When a label is added or removed
  } else if (onBoarding && (action === "labeled" || action === "unlabeled")) {
    logger.debug("starting labeled flow");

    // Do nothing if this was just triggered from a previous update
    if (await sentByThisApp(app, context)) {
      logger.debug("Skipping labeled event because update was sent by current app");
      return;
    }

    const { owner, repo, number: pull_number } = context.issue();

    const newMessage = onBoardingMessage(await createLabelChecklists(context, config, true));

    const checklistChanged = didChecklistsChange(newMessage, parseMessage(pull_request.body));

    logger.debug("Did checklist change?", checklistChanged);

    if (checklistChanged) {
      logger.debug("Writing body from label updates");
      const body = overwriteMessage(context, newMessage);
      const [updateBodyError] = await to(
        context.github.pulls.update({
          owner,
          repo,
          pull_number,
          body,
        }),
      );

      if (updateBodyError) {
        logger.error("Failed to update body after label updates");
        throw updateBodyError;
      }
    }
  } else {
    logger.debug(`No change needed for action ${action}`);
  }
};
