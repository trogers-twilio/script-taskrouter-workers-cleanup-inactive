# script-taskrouter-workers-cleanup-inactive
Node.js script that uses the Twilio Helper Library to update and/or delete workers that have not had an activity change with a configurable number of days.

This script will help with two primary use cases:

* Ensuring inactive workers are not counting toward the workspace maximum limit of 15,000 workers
* Ensuring Flex customers on a named user billing plan are not billed for inactive workers

This script also supports updating worker attributes to specific values or clearing/deleting worker attributes before the worker is deleted. This can help ensure reporting tools, like Flex Insights, are updated with the desired attribute values for each deleted worker, since the `worker.deleted` event will trigger an update to the associated Agent attributes in Flex Insights.

A full list of available Flex Insights Agent attributes is available here:

https://www.twilio.com/docs/flex/end-user-guide/insights/data-model#agents

More information on using task and worker attributes to populate Flex Insights data is available here:

https://www.twilio.com/docs/flex/developer/insights/enhance-integration

## Pre-requisites
Node.js, preferably a LTS release. This script was tested using Node.js version 14.18.1
 
## Setup
1. Clone the repository, open a terminal, and change to the repo directory
2. Run `npm install`
3. Copy or rename `.env.sample` to `.env`
4. Edit the `.env` file with the appropriate values for the target Twilio account and desired script behavior

## Using the script
To run the script, simply use the command:

```bash
node index.js
```

## Output files
The targeted list of inactive workers to update and/or delete is output to a CSV file in the `output` directory where the script is executed.

If there are any errors detected while updating and/or deleting the target workers, a separate CSV file in the same `output` directory will be created with `_errors` appended to the end of the filename.
