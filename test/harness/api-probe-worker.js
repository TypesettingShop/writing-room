// The API probe's extension host Worker. Static imports evaluate in order: the recorder replaces `Function`, the
// product's Worker entry evaluates (its loader captures the wrapper), then `Function` is restored for extension code.
// This file is JavaScript so that the browser type check does not pull the Worker sources into the DOM project.
import './api-probe-recorder.ts';
import '../../src/workbench/api/worker/extensionHostWorkerMain.ts';
import './api-probe-restore.ts';
