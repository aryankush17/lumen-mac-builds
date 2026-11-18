import {createContext} from 'react';
export const RecordPageNavigation=createContext<(document:any[],blockId:string,recordId:string)=>Promise<void>>(async()=>{});
