'use strict';
(function(){
  try{
    if(window.top===window.self){
      document.documentElement.classList.remove('frame-guard');
      return;
    }
  }catch{}
  // GitHub Pages cannot emit X-Frame-Options / frame-ancestors headers.
  // Keep framed copies visually blank as a client-side defense in depth.
  window.stop();
})();
