1. Run deployment/windows/CONFIGURE_FRONTEND.cmd and enter the public HTTPS backend URL.
2. Upload the CONTENTS of this folder to the GitHub repository publishing root.
3. GitHub repository > Settings > Pages > Deploy from a branch > main / (root).
4. The browser Origin for a project page such as
   https://USER.github.io/REPOSITORY/
   is only https://USER.github.io . Put that origin in backend collector.env ALLOWED_ORIGINS.
