// Independent fixture transcribed from the owner-supplied verified datasource.
import {SOURCE} from '../providers.mjs';
export function schema() {
 const select=names=>({type:'select',select:{options:names.map(name=>({name}))}});
 return {id:SOURCE,properties:{Title:{type:'title'},
  'Ticket Kind':select(['Membership']), 'Request Channel':select(['Website']),
  Status:select(['Inbox','New','Waiting','Closed','Done','Dropped']),
  'Membership Decision':select(['Pending','Approved','Declined','Not applicable']),
  'External Case ID':{type:'rich_text'},Link:{type:'url'}
 }};
}
