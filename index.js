const Twilio = require('twilio');
const moment = require('moment');
const { parse } = require('json2csv');
const { writeFile } = require('node:fs/promises');
require('dotenv').config();

const { confirmTargetAccount, confirmToProceed } = require('./helpers/utils');

const {
  CLEAR_WORKER_ATTRIBUTES,
  CSV_FILENAME_PREFIX,
  DELETE_WORKER_ATTRIBUTES,
  EXPORT_WORKER_ATTRIBUTES,
  EXPORT_WORKER_PROPERTIES,
  MAX_DAYS_SINCE_LAST_STATUS_CHANGE,
  MAX_WORKERS_TO_DELETE,
  POPULATE_WORKER_ATTRIBUTES,
  SORT_WORKER_DIRECTION,
  SORT_WORKER_FIELD,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WORKSPACE_SID,
} = process.env;

const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const maxDaysSinceLastStatusChange = parseInt(MAX_DAYS_SINCE_LAST_STATUS_CHANGE);

const timestamp = moment().format('YYYY-MM-DDTHH-mm-ssZZ');

let matchingWorkers = [];
const workersToDelete = new Map();
let sortedWorkersToDelete = [];
const failedWorkers = new Map();

const validateVariables = () => {
  let response = true;

  if (typeof maxDaysSinceLastStatusChange !== 'number' ) {
    console.log('Environment variable MAX_DAYS_SINCE_LAST_STATUS_CHANGE is not a number.');
    response = false;
  }

  return response;
}

const getAllWorkers = () => {
  return client.taskrouter
    .workspaces(TWILIO_WORKSPACE_SID)
    .workers
    .list({
      pageSize: 1000
    });
};

const isLastStatusChangeGreaterThanMax = (dateStatusChanged) => {
  const maxDaysSinceLastStatusChangeMilliseconds = maxDaysSinceLastStatusChange * 24 * 60 * 60 * 1000;
  const maxDateStatusChanged = new Date().getTime() - maxDaysSinceLastStatusChangeMilliseconds;

  return maxDateStatusChanged > dateStatusChanged;
}

const populateWorkerMetadata = (worker) => {
  const populatedWorker = {};

  const desiredProperties = EXPORT_WORKER_PROPERTIES.split(',');
  for (const prop of desiredProperties) {
    populatedWorker[prop] = worker[prop]
  }

  const desiredAttributes = EXPORT_WORKER_ATTRIBUTES.split(',');
  const workerAttributes = JSON.parse(worker.attributes);
  for (const attr of desiredAttributes) {
    if (attr === 'date_left' || attr === 'date_joined') {
      populatedWorker[attr] = typeof workerAttributes[attr] === 'number'
        ? new Date(workerAttributes[attr]).toISOString()
        : "";
    }
    else if (attr.includes('.')) {
      const splitAttr = attr.split('.');

      populatedWorker[attr] = workerAttributes[splitAttr[0]]
        ? workerAttributes[splitAttr[0]][splitAttr[1]]
        : "";
    }
    else {
      populatedWorker[attr] = workerAttributes[attr];
    }
  }

  workersToDelete.set(worker.sid, populatedWorker);
}

const sortByDateString = (a, b) => {
  return SORT_WORKER_DIRECTION && SORT_WORKER_DIRECTION.toLowerCase() === 'desc'
  ? new Date(b) - new Date(a)
  : new Date(a) - new Date(b);
}

const sortWorkers = () => {
  const workersArray = Array.from(workersToDelete.values());

  if (SORT_WORKER_FIELD) {
    console.log(`\nSorting workers by ${SORT_WORKER_FIELD} in ` +
      `${SORT_WORKER_DIRECTION === 'desc' ? 'Descending' : 'Ascending'} order`);
    workersArray.sort((a, b) => {
      const aValue = a[SORT_WORKER_FIELD];
      const bValue = b[SORT_WORKER_FIELD];

      if (Date.parse(aValue) || Date.parse(bValue)) {
        return sortByDateString(aValue, bValue);
      }
    })
  }

  sortedWorkersToDelete = workersArray;
}

const exportWorkersToFile = async () => {
  console.log('\nParsing workers array to CSV format');
  const workersCsv = parse(sortedWorkersToDelete);

  const fileNameWithTimestamp = `${CSV_FILENAME_PREFIX}_${timestamp}.csv`
  console.log('Writing workers to file', fileNameWithTimestamp);
  await writeFile(fileNameWithTimestamp, workersCsv);
  console.log('Workers CSV file created');
}

const exportFailedWorkersToFile = async () => {
  if (failedWorkers.size === 0) {
    return;
  }
  console.log('\nThere were', failedWorkers.size, 'workers that failed to update and were not deleted');
  const failedWorkersExport = Array.from(failedWorkers.values()).map(w => ({
     ...w.worker,
     'error.status': w.error.status,
     'error.message': w.error.message
  }));
  console.log('Parsing failed workers array to CSV format');
  const workersCsv = parse(failedWorkersExport);

  const fileNameWithTimestamp = `${CSV_FILENAME_PREFIX}_${timestamp}_errors.csv`
  console.log('Writing failed workers to file', fileNameWithTimestamp);
  await writeFile(fileNameWithTimestamp, workersCsv);
  console.log('Failed workers CSV file created');
}

const searchWorkers = async () => {
  console.log('Fetching all TaskRouter workers');
  const allWorkers = await getAllWorkers();

  if (!Array.isArray(allWorkers) || allWorkers.length === 0) {
    console.log('No workers found.');
    return;
  }

  matchingWorkers = allWorkers.filter(w => {
    return isLastStatusChangeGreaterThanMax(w.dateStatusChanged);
  });

  console.log('Found', matchingWorkers.length, 'workers with status change greater than', maxDaysSinceLastStatusChange, 'days');

  if (matchingWorkers.length === 0) {
    return;
  }

  console.log('Populating worker metadata');
  for (const worker of matchingWorkers) {
    populateWorkerMetadata(worker);
  }
}

const trimWorkersToDelete = () => {
  const maxWorkersToDelete = MAX_WORKERS_TO_DELETE && parseInt(MAX_WORKERS_TO_DELETE);
  if (typeof maxWorkersToDelete === 'number') {
    console.log('\nTrimming list of workers to max of', maxWorkersToDelete);
    sortedWorkersToDelete.splice(0 + maxWorkersToDelete);
  }
}

const updateWorkerAttributes = async () => {
  if (!CLEAR_WORKER_ATTRIBUTES && !DELETE_WORKER_ATTRIBUTES && !POPULATE_WORKER_ATTRIBUTES) {
    return;
  }
  const attributesToClear = CLEAR_WORKER_ATTRIBUTES ? CLEAR_WORKER_ATTRIBUTES.split(',') : [];
  const attributesToDelete = DELETE_WORKER_ATTRIBUTES ? DELETE_WORKER_ATTRIBUTES.split(',') : [];
  const attributesToPopulate = POPULATE_WORKER_ATTRIBUTES ? POPULATE_WORKER_ATTRIBUTES.split(',') : [];
  console.log(`\nUpdating ${sortedWorkersToDelete.length} inactive workers to:` +
    `${attributesToClear.length > 0 ? `\n- Clear attributes [${CLEAR_WORKER_ATTRIBUTES}]` : ''}` +
    `${attributesToDelete.length > 0 ? `\n- Delete attributes [${DELETE_WORKER_ATTRIBUTES}]` : ''}` +
    `${attributesToPopulate.length > 0 ? `\n- Populate attributes [${POPULATE_WORKER_ATTRIBUTES}]` : ''}`
  );
  for (const worker of sortedWorkersToDelete) {
    const targetWorker = matchingWorkers.find(w => w.sid === worker.sid);

    const newAttributes = {
      ...(targetWorker.attributes && JSON.parse(targetWorker.attributes))
    }
    
    for (const key of attributesToClear) {
      if (newAttributes[key]) {
        newAttributes[key] = "";
      }
    }
    for (const key of attributesToDelete) {
      delete newAttributes[key];
    }
    for (const pair of attributesToPopulate) {
      const keyValue = pair.split(':');
      const key = keyValue[0];
      const value = keyValue[1];

      newAttributes[key] = value;
    }
    console.log('Updating attributes for', worker.friendlyName);
    try {
      await client.taskrouter
        .workspaces(TWILIO_WORKSPACE_SID)
        .workers(worker.sid)
        .update({
          attributes: JSON.stringify(newAttributes)
        });
    } catch (error) {
      console.error(`Error updating worker ${worker.friendlyName}.`, error.status, error.message);
      failedWorkers.set(worker.sid, { worker, error });
    }
  }
}

const deleteWorkers = async () => {
  console.log(`\nDeleting ${sortedWorkersToDelete.length - failedWorkers.size} inactive workers`);
  for (const worker of sortedWorkersToDelete) {
    if (failedWorkers.has(worker.sid)) {
      console.log(`Skipping deletion of ${worker.friendlyName} since worker update failed`);
    } else {
      console.log('Deleting', worker.friendlyName);
      try {
        await client.taskrouter
          .workspaces(TWILIO_WORKSPACE_SID)
          .workers(worker.sid)
          .remove();
      } catch (error) {
        console.error(`Error deleting worker ${worker.friendlyName}.`, error.status, error.message);
        failedWorkers.set(worker.sid, { worker, error });
      }
    }
  }
}

const runScript = async () => {
  let isConfirmed = await confirmTargetAccount(client);
  if (!isConfirmed) {
    return;
  }

  const areVariablesValid = validateVariables();

  if (!areVariablesValid) {
    console.log('Fix invalid environment variables and re-run script\n');
    return;
  }

  await searchWorkers();

  if (workersToDelete.size === 0) {
    console.log('There are no workers to delete. Nothing further to do.\n');
    return;
  }

  sortWorkers();

  trimWorkersToDelete();

  await exportWorkersToFile();

  const confirmationMessage = '\nThe script will now update the target workers and delete them.\n' +
    'Please review the CSV file to see which workers will be affected.';
  isConfirmed = await confirmToProceed(confirmationMessage);
  if (!isConfirmed) {
    return;
  }

  await updateWorkerAttributes();

  await deleteWorkers();

  await exportFailedWorkersToFile();

  let summaryMessage = '\nScript is complete. Summary:\n';
  summaryMessage += `- Updated and removed ${sortedWorkersToDelete.length - failedWorkers.size} inactive workers.\n`;
  summaryMessage += failedWorkers.size > 0 ? `- Failed to update ${failedWorkers.size} workers. Those workers were not deleted.\n` : ''

  console.log(summaryMessage);
}

runScript();

