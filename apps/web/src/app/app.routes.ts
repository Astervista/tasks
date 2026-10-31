import { Route } from '@angular/router';

/** The App component reads the URL itself: "/" is the picker, "/w/:uid" an open workspace */
export const appRoutes: Route[] = [
  { path: 'w/:uid', children: [] },
  { path: '', children: [] },
  { path: '**', redirectTo: '' },
];
