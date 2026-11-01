/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigationFocus } from "../../hooks/use-navigation-focus";
import { Toast } from "../toast";
import { AuthMode, initialAuthMode } from "./common";
import { useThemeColors } from "@notesnook/theme";
import { NavigationProps } from "../../services/navigation";
import { RyteConnect } from "../../ryte/ryte-connect";
import { db } from "../../common/database";
import PremiumService from "../../services/premium";
import SettingsService from "../../services/settings";
import Sync from "../../services/sync";
import { eSendEvent } from "../../services/event-manager";
import { useUserStore } from "../../stores/use-user-store";
import { eUserLoggedIn } from "../../utils/events";
import { sleep } from "../../utils/time";
import { hideAuth } from "./common";

const Auth = ({ navigation, route }: NavigationProps<"Auth">) => {
  const { colors } = useThemeColors();
  initialAuthMode.current = route?.params.mode || AuthMode.login;
  useNavigationFocus(navigation, {});

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.primary.background }}
    >
      {/* Ryte: no Notesnook accounts; sign-in = connect MEGA / Filen */}
      <RyteConnect
        onDone={async () => {
          const user = await db.user.getUser();
          if (user) useUserStore.getState().setUser(user);
          PremiumService.setPremiumStatus();
          SettingsService.set({
            sessionExpired: false,
            userEmailConfirmed: true
          });
          eSendEvent(eUserLoggedIn, true);
          await sleep(300);
          hideAuth(route?.params?.context);
          setTimeout(() => {
            if (!useUserStore.getState().syncing) {
              Sync.run("global", false, "full");
            }
          }, 1000);
        }}
      />

      <Toast context="local" />
    </SafeAreaView>
  );
};

export default Auth;
