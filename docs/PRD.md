# DebugWise

A VS Code debugging assistant that helps non-technical builders fix bugs and understand their own code.

| | |
|---|---|
| Project owner | Kaheel Adnan |
| Status | Draft · working local prototype |
| Last updated | November 19, 2026 |
| Resources | [Technical specification](TECHNICAL_SPEC.md) · [Project README](../README.md) · [Prototype screenshot](screenshot.png) |

## Problem Alignment

AI coding tools make it possible to build working software without formal training. When that software breaks, builders still have to make sense of error messages, code changes, and test output before they can decide whether to trust a fix. That leaves people dependent on the same tool the next time something breaks.

The initial audience is **AI-assisted builders and low-code or no-code builders who maintain a small JavaScript or TypeScript project or an exported Apps Script project**. Product managers, analysts, and designers who maintain occasional scripts are a secondary audience. The founder's experience building Quickity and observing people struggle with tools like Claude Code motivated the product. That evidence is anecdotal. The first pilot should test how common the problem is and which audience feels it most acutely.

### High Level Approach

Put a debugging conversation inside the editor. The builder describes the symptom in ordinary language. DebugWise looks at relevant code and recent changes, explains the likely cause, and shows the proposed edit in terms the builder can act on. After an applied fix, a short coding lesson walks through the debugging decisions and teaches one concept using the builder's own code.

### Narrative

A builder changes the inputs to a pricing function. Checkout starts producing the wrong total. DebugWise points to the files still calling the function with the old inputs, explains the symptom, and previews each edit. The builder can approve or reject each change and see what checks found. The lesson explains why code that uses a function needs to agree with the inputs it expects.

An Apps Script builder reports that a slide button stopped working. DebugWise can inspect exported script files and propose a change. The builder verifies it in Google Slides when the behavior depends on the hosted runtime.

### Goals

| Priority | Goal | Proposed pilot measure |
|---|---|---|
| 1 | Builders understand the fix and feel able to judge the next one | At least 80% explain the symptom, cause, and change in their own words or correctly answer the lesson question. Mean clarity rating at least 4/5. |
| 2 | Restore intended behavior with a small, reviewable change | At least 70% behavioral fix rate on seeded cases, three runs per case. Report counts and breakdowns by bug class. |
| 3 | Keep builders in control and earn their trust | Zero file writes through edit cards without approval and zero commands requiring approval started without it. At least 95% of reviewed explanations have no unsupported factual claims. |
| 4 | Make the experience usable without coaching | At least four of the first five target users set up the prototype and complete a debugging task without facilitator help. Record where setup fails. |
| 5 | Learn what each fix costs | Measure tokens, latency, and estimated API cost per completed fix. Set a cost target after establishing the baseline. |

These are proposed targets. The minimum initial usability sample is five target users. Report the sample size and track comprehension, explanation accuracy, and fix rate together.

### Non-goals

- Whole-app generation, automatic deployment, and hosting user projects. The first release focuses on understanding and fixing existing code.
- Broad language coverage and browser or Google Workspace runtime automation. Start with locally available JavaScript, TypeScript, and Apps Script source.
- Replacing a professional debugger or proving a project is regression-free. Inspection and local checks provide evidence for a specific fix.

| Reviewer | Team or role | Status |
|---|---|---|
| Kaheel Adnan | Project owner | Pending problem review |

## Solution Alignment

### Key Features

| Priority | Plan of record | Local prototype status |
|---|---|---|
| P0 | VS Code sidebar for bug reports and code questions, with streamed replies and a clickable activity trail | Implemented. The CLI shares the same agent engine. |
| P0 | Use recent changes to identify affected functions and other code that calls them | Implemented for supported code. Free-text investigation can proceed without Git history. |
| P0 | Explain each proposed edit, show the diff and risk reasons, and give the builder control over whether to apply or undo it | Implemented. Undo is available within the active session when the saved file still matches the applied edit. |
| P0 | Show what terminal checks do, whether they ran, and their results | Implemented. Checks classified by the app can run automatically. Other commands ask for approval and show why. |
| P0 | Teach one coding concept after an applied fix | Implemented. The collapsible lesson walks through the steps and why they mattered, then gives an analogy, an example from the user's code, terms, and a check question. |
| P1 | Help the builder understand usage and revisit activity | Session token count and a local run log are implemented. A spend estimate is a future consideration. |

**Future considerations.** A sample project or recorded demo that works without an API key, simpler onboarding, teaching-depth controls, and better coverage for code embedded in HTML. Compare models on fix quality, explanation quality, and cost before changing the default or splitting the work across models.

### Key Flows

| Scenario | Builder experience | Acceptance criteria |
|---|---|---|
| Investigate and fix | Open a project, set an API key, describe what went wrong, inspect the proposal, approve, and review the checks and lesson | The proposal identifies the file, the change, risk reasons, and a plain-English explanation before the file is written. The final reply tells the user what to verify in the app when local checks cannot cover it. |
| Understand only | Ask what a piece of code does or follow up on a lesson | The answer explains the behavior in everyday words. The agent is instructed to answer questions without edits. |
| Reject or undo | Reject a proposal, stop a run, or undo an applied change | Rejection leaves the proposed change unapplied. Undo restores the saved earlier version when it would leave later work intact. |
| Work with partial evidence | Open a project without commits, or troubleshoot a bug that needs Google Slides to reproduce | Investigation continues from the report and available code. The user can tell what was checked and what still needs a manual test. |

### Key Logic

- The agent is instructed to reproduce the symptom where possible, explain the likely cause before the first edit, make a small correction, and recheck behavior and affected code.
- Edit approval applies at every risk level. Unsaved editor changes and stale file contents can block a proposed write.
- A syntax error or a concrete mismatch in code calling a changed function raises edit risk. A tentative match is labeled as such. Risk labels communicate what the analyzer found and leave runtime behavior for tests.
- The lesson draws from the recorded steps. Showing that a test ran, a connection was found, or a cause was confirmed requires evidence. Assess claims in the live reply and lesson separately.
- The hosted model receives relevant project context. The local run log can contain prompts, diffs, commands, and output. The pilot setup should make both clear.

| Reviewer | Team or role | Status |
|---|---|---|
| Kaheel Adnan | Project owner | Pending solution review |

## Launch Plan

### Key Milestones

| Target date | Milestone | Description | Exit criteria |
|---|---|---|---|
| Prototype available locally | Working build | Run the sidebar and CLI from source with a user-provided OpenAI key | Confirm the approval, rejection, undo, and lesson flows in a live extension run. |
| TBD | Eval baseline | Run the seeded suite repeatedly and review transcripts | Publish counts for fix rate, explanation accuracy, and approval behavior. Establish a cost baseline. |
| TBD | Usability pilot | Test setup and a full debugging task with at least five target builders | Four of five finish without coaching, at least 80% meet the comprehension criterion, clarity averages at least 4/5, and approval guardrails hold. |
| TBD | Shareable preview | Package setup instructions, a demo, known limitations, and measured results | A new user can complete setup and try the demo. Any user data and API key requirements are clear before use. |

### Operational Checklist

| Area | Before the pilot or preview |
|---|---|
| Measurement | Use the seeded suite alongside a transcript rubric and a short usability script. Log fix success and clarity independently. |
| Setup and support | Document the build, first workspace folder, API key setup, billing errors, undo limits, and manual Apps Script testing. |
| Risk and privacy | Validate command approval behavior and review automatic checks, filesystem boundaries, and what goes into model context and logs. Use representative pilot code that participants can share with the provider. |
| Positioning | Describe DebugWise as a debugging and learning tool for non-engineers. Validate the Apps Script and AI-assisted builder segments before picking one. |
| Pricing and distribution | Collect key-setup friction and per-fix usage. Decide how users get the extension and pay for usage after the pilot. |

## Appendix

### Changelog

| Date | Update |
|---|---|
| November 19, 2026 | Reworked Claude's draft using Kevin Yien's PRD structure. Updated the feature inventory and launch gates against local revision `3600941`. |

### Open Questions

- Which audience should lead the pilot: Apps Script and Workspace add-on builders, or AI-assisted builders of small web apps?
- Will the VS Code and API key setup be manageable for the audience that needs the most help?
- Should teaching remain part of every applied fix, or should experienced repeat users be able to reduce the detail?
- Which model gives the best result at a workable cost, and would offering a managed key improve onboarding enough to justify it?
- How often do users need runtime or HTML-embedded script support in their first debugging task?

### FAQs

**Can I ask how my code works?** Yes. You can ask a question without requesting a fix or ask a follow-up after a lesson.

**Can DebugWise verify my Google Slides add-on?** It can inspect exported `.gs` files. Test behavior that uses Google services in the actual add-on.

**Where can I see the implementation details?** See the [technical specification](TECHNICAL_SPEC.md) for the agent loop, edit lifecycle, lesson format, and evaluation coverage.
