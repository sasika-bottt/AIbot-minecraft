const { contextBridge } = require('electron');
const state = {mode:'manual', messages:[]};
const p = (x,y,z,name) => ({x,y,z,name});
contextBridge.exposeInMainWorld('whale', {
  buildPlannerState: async () => state, survivalStatus: async () => ({job:null,agent:{phase:'idle',message:'尚无施工任务。'}}),
  generateSurvivalBlueprint: async () => ({dimension:'minecraft:overworld',bounds:{min:p(0,64,0),max:p(1,64,0)},blocks:[p(0,64,0,'dirt')],sources:[p(5,64,0,'dirt')]}),
  setBuildPlannerMode: async () => state, clearBuildConversation: async () => state, sendBuildMessage: async () => state,
  discussWithAgent: async () => state, executeAdminBuild: async () => ({}), startSurvivalBuild: async () => ({}),
  resumeSurvivalBuild: async () => ({}), stopSurvivalBuild: async () => ({})
});
