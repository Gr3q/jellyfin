define(["appSettings","events","browser"],function(appsettings,events,browser){"use strict";function onSaveTimeout(){var self=this;self.saveTimeout=null,self.currentApiClient.updateDisplayPreferences("usersettings",self.displayPrefs,self.currentUserId,"emby")}function saveServerPreferences(instance){instance.saveTimeout&&clearTimeout(instance.saveTimeout),instance.saveTimeout=setTimeout(onSaveTimeout.bind(instance),50)}function UserSettings(){}function getSavedQueryKey(context){return"query-"+context}return UserSettings.prototype.setUserInfo=function(userId,apiClient){if(this.saveTimeout&&clearTimeout(this.saveTimeout),this.currentUserId=userId,this.currentApiClient=apiClient,!userId)return this.displayPrefs=null,Promise.resolve();var self=this;return apiClient.getDisplayPreferences("usersettings",userId,"emby").then(function(result){result.CustomPrefs=result.CustomPrefs||{},self.displayPrefs=result})},UserSettings.prototype.getData=function(){return this.displayPrefs},UserSettings.prototype.importFrom=function(instance){this.displayPrefs=instance.getData()},UserSettings.prototype.set=function(name,value,enableOnServer){var userId=this.currentUserId;if(!userId)throw new Error("userId cannot be null");var currentValue=this.get(name);appsettings.set(name,value,userId),enableOnServer!==!1&&this.displayPrefs&&(this.displayPrefs.CustomPrefs[name]=null==value?value:value.toString(),saveServerPreferences(this)),currentValue!==value&&events.trigger(this,"change",[name])},UserSettings.prototype.get=function(name,enableOnServer){var userId=this.currentUserId;return userId?enableOnServer!==!1&&this.displayPrefs?this.displayPrefs.CustomPrefs[name]:appsettings.get(name,userId):null},UserSettings.prototype.serverConfig=function(config){var apiClient=this.currentApiClient;return config?apiClient.updateUserConfiguration(this.currentUserId,config):apiClient.getUser(this.currentUserId).then(function(user){return user.Configuration})},UserSettings.prototype.enableCinemaMode=function(val){return null!=val&&this.set("enableCinemaMode",val.toString(),!1),val=this.get("enableCinemaMode",!1),!val||"false"!==val},UserSettings.prototype.enableThemeSongs=function(val){return null!=val&&this.set("enableThemeSongs",val.toString(),!1),val=this.get("enableThemeSongs",!1),"false"!==val},UserSettings.prototype.enableThemeVideos=function(val){return null!=val&&this.set("enableThemeVideos",val.toString(),!1),val=this.get("enableThemeVideos",!1),val?"false"!==val:!browser.slow},UserSettings.prototype.language=function(val){return null!=val&&this.set("language",val.toString(),!1),this.get("language",!1)},UserSettings.prototype.skipBackLength=function(val){return null!=val&&this.set("skipBackLength",val.toString()),parseInt(this.get("skipBackLength")||"15000")},UserSettings.prototype.skipForwardLength=function(val){return null!=val&&this.set("skipForwardLength",val.toString()),parseInt(this.get("skipForwardLength")||"15000")},UserSettings.prototype.loadQuerySettings=function(query,context){var key=getSavedQueryKey(context),values=this.get(key);if(values)return values=JSON.parse(values),Object.assign(query,values)},UserSettings.prototype.saveQuerySettings=function(query,context){var key=getSavedQueryKey(context),values={};query.SortBy&&(values.SortBy=query.SortBy),query.SortOrder&&(values.SortOrder=query.SortOrder),this.set(key,JSON.stringify(values))},UserSettings});