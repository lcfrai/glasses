export const ADOPTION_LABELS=Object.freeze({
  'configure-agent':'Add to an existing agent',
  'deploy-service':'Self-host the application',
  'embed-package':'Import a package',
  'adapt-source':'Copy or adapt source',
  'replace-workflow':'Use as the main workspace',
  'install-app':'Install an application',
  'run-cli':'Run a command-line tool',
  'use-hosted':'Use the hosted service',
  'integrate-api':'Connect its API',
  'browser-extension':'Install a browser extension',
  reference:'Read as a reference',unknown:'Setup not established'
});
export const ADOPTION_DETAILS=Object.freeze({
  'deploy-service':'A way to run this product on your infrastructure. This does not mean it deploys other applications.',
  'configure-agent':'Extend the agent you already use.',
  'replace-workflow':'The product becomes the workspace for this task.',
  'embed-package':'Integrate the library into your application code.',
  'adapt-source':'Bring editable source into your project.',
  'install-app':'Install the documented desktop or mobile application.',
  'run-cli':'Use the command-line tool to perform the task.',
  'use-hosted':'Use the provider’s documented hosted application.',
  'integrate-api':'Connect through the documented service API.',
  'browser-extension':'Install the documented browser add-on.',
  reference:'Read the source material as guidance.',
  unknown:'Inspect the source to establish an appropriate setup route.'
});
const PURPOSE_LABELS=Object.freeze({'ui-components':'UI components',mcp:'MCP integration',crm:'Customer relationship management','deployment-management':'Application deployment management',deployment:'Deployment (legacy label)','api-development':'API development','forms-surveys':'Forms and surveys','file-sync-sharing':'File sync and sharing','document-editing':'Document editing','real-time-collaboration':'Real-time collaboration','local-first':'Local-first operation','business-intelligence':'Business intelligence','run-cli':'Command-line use'});
export const purposeLabel=value=>PURPOSE_LABELS[value]||String(value||'Unknown').replaceAll('-',' ').replace(/^./,c=>c.toUpperCase());
export const adoptionLabel=value=>ADOPTION_LABELS[value]||String(value||'Setup not established').replaceAll('-',' ').replace(/^./,c=>c.toUpperCase());
export const RESOURCE_LABELS={tool:'Tools',component:'Components',skill:'Skills',agent:'Agents',collection:'Collections',reference:'References'};
export const resourceType=item=>Object.hasOwn(RESOURCE_LABELS,item?.details?.resourceType)?item.details.resourceType:item?.kind==='component'?'component':item?.kind==='solution'?'tool':'reference';
