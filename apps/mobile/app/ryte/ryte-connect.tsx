/*
This file is part of the Ryte project.

Copyright (C) 2026 Ryte contributors

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

import type { CloudProvider } from "@notesnook/core";
import { useThemeColors } from "@notesnook/theme";
import React, { useEffect, useRef, useState } from "react";
import { TextInput, TouchableOpacity, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import { db } from "../common/database";
import { AuthHeader } from "../components/auth/header";
import { Button } from "../components/ui/button";
import FormInput, {
  createFormRef,
  validators
} from "../components/ui/input/form-input";
import Heading from "../components/ui/typography/heading";
import Paragraph from "../components/ui/typography/paragraph";
import { AppFontSize } from "../utils/size";
import { DefaultAppStyles } from "../utils/styles";
import { CloudStatus, RyteCloud } from "./bridge";

/**
 * Ryte sign-in: 1) connect MEGA or Filen, 2) enter the encryption password.
 * Notes are encrypted with that password on the device before they are
 * stored in the user's drive.
 */
export const RyteConnect = (props: { onDone: () => void }) => {
  const [status, setStatus] = useState<CloudStatus | undefined>(
    RyteCloud.status()
  );

  useEffect(() => RyteCloud.onStatus(setStatus), []);

  return (
    <>
      <AuthHeader />
      <KeyboardAwareScrollView
        style={{ width: "100%" }}
        contentContainerStyle={{ minHeight: "90%" }}
        nestedScrollEnabled
        enableAutomaticScroll
        keyboardShouldPersistTaps="handled"
      >
        {status ? (
          <PasswordStep
            status={status}
            onDone={props.onDone}
            onChangeStorage={() => RyteCloud.disconnect()}
          />
        ) : (
          <StorageStep />
        )}
      </KeyboardAwareScrollView>
    </>
  );
};

function Title(props: { title: string; text: string }) {
  const { colors } = useThemeColors();
  return (
    <View
      style={{
        paddingHorizontal: DefaultAppStyles.GAP,
        marginBottom: DefaultAppStyles.GAP_VERTICAL,
        borderBottomWidth: 0.8,
        borderBottomColor: colors.primary.border,
        paddingBottom: DefaultAppStyles.GAP_VERTICAL
      }}
    >
      <View style={{ flexDirection: "row", marginTop: 40 }}>
        <View
          style={{
            width: 100,
            height: 5,
            backgroundColor: colors.primary.accent,
            borderRadius: 2,
            marginRight: 7
          }}
        />
        <View
          style={{
            width: 20,
            height: 5,
            backgroundColor: colors.secondary.background,
            borderRadius: 2
          }}
        />
      </View>
      <Heading
        style={{ marginTop: DefaultAppStyles.GAP_VERTICAL }}
        extraBold
        size={AppFontSize.xxl}
      >
        {props.title}
      </Heading>
      <Paragraph
        style={{ marginTop: DefaultAppStyles.GAP_VERTICAL_SMALL }}
        color={colors.secondary.paragraph}
      >
        {props.text}
      </Paragraph>
    </View>
  );
}

function StorageStep() {
  const { colors } = useThemeColors();
  const [provider, setProvider] = useState<CloudProvider>("mega");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const passwordRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);
  const formRef = useRef(
    createFormRef({ email: "", password: "", code: "" })
  );
  const name = provider === "mega" ? "MEGA" : "Filen";

  const connect = async () => {
    if (loading) return;
    setError(undefined);
    if (!formRef.current.validate()) return;
    setLoading(true);
    try {
      const values = formRef.current.getValues();
      await RyteCloud.connect(
        provider,
        values.email,
        values.password,
        values.code
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View>
      <Title
        title="Connect your cloud storage"
        text="Ryte keeps your notes and attachments end-to-end encrypted in your own MEGA or Filen account. Every feature is included and there are no upload limits: the only limit is the free space in your account."
      />
      <View
        style={{
          paddingHorizontal: DefaultAppStyles.GAP,
          gap: DefaultAppStyles.GAP_VERTICAL
        }}
      >
        <View style={{ flexDirection: "row", gap: 10 }}>
          {(["mega", "filen"] as const).map((id) => (
            <TouchableOpacity
              key={id}
              testID={`ryte.provider.${id}`}
              activeOpacity={0.8}
              onPress={() => setProvider(id)}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 8,
                alignItems: "center",
                borderWidth: 1.5,
                borderColor:
                  provider === id
                    ? colors.primary.accent
                    : colors.primary.border,
                backgroundColor:
                  provider === id
                    ? colors.primary.shade
                    : colors.primary.background
              }}
            >
              <Paragraph
                color={
                  provider === id
                    ? colors.primary.accent
                    : colors.primary.paragraph
                }
                style={{ fontWeight: "bold" }}
              >
                {id === "mega" ? "MEGA" : "Filen"}
              </Paragraph>
            </TouchableOpacity>
          ))}
        </View>

        <FormInput
          name="email"
          formRef={formRef}
          testID="input.email"
          returnKeyType="next"
          autoComplete="email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          marginBottom={0}
          placeholder={`${name} email`}
          editable={!loading}
          validators={[
            validators.required("Enter your email."),
            validators.email("Enter a valid email address.")
          ]}
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <FormInput
          name="password"
          formRef={formRef}
          fwdRef={passwordRef}
          testID="input.password"
          returnKeyType="next"
          secureTextEntry
          autoComplete="password"
          autoCapitalize="none"
          autoCorrect={false}
          marginBottom={0}
          placeholder={`${name} password`}
          editable={!loading}
          validators={[validators.required("Enter your password.")]}
          onSubmitEditing={() => codeRef.current?.focus()}
        />
        <FormInput
          name="code"
          formRef={formRef}
          fwdRef={codeRef}
          testID="input.code"
          returnKeyType="done"
          keyboardType="number-pad"
          autoComplete="one-time-code"
          marginBottom={0}
          placeholder="Two-factor code (only if you use it)"
          editable={!loading}
          onSubmitEditing={connect}
        />
        <Paragraph size={AppFontSize.xs} color={colors.secondary.paragraph}>
          Your {name} password is used once to sign in. Ryte keeps only the
          session on this device, never the password.
        </Paragraph>
        {error ? (
          <Paragraph size={AppFontSize.sm} color={colors.error.paragraph}>
            {error}
          </Paragraph>
        ) : null}
        <Button
          loading={loading}
          onPress={connect}
          style={{ width: "100%" }}
          type="accent"
          title={loading ? null : `Connect ${name}`}
          fontSize={AppFontSize.sm}
        />
      </View>
    </View>
  );
}

function PasswordStep(props: {
  status: CloudStatus;
  onDone: () => void;
  onChangeStorage: () => void;
}) {
  const { colors } = useThemeColors();
  const { status } = props;
  const [isNew, setIsNew] = useState<boolean>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const confirmRef = useRef<TextInput>(null);
  const formRef = useRef(createFormRef({ password: "", confirm: "" }));

  useEffect(() => {
    db.ryte
      .exists()
      .then((exists) => setIsNew(!exists))
      .catch((e) => setError((e as Error).message));
  }, [status.provider, status.email]);

  const unlock = async () => {
    if (loading || isNew === undefined) return;
    setError(undefined);
    if (!formRef.current.validate()) return;
    const { password, confirm } = formRef.current.getValues();
    if (isNew && password !== confirm)
      return setError("Passwords do not match.");
    if (isNew && password.length < 8)
      return setError("Use at least 8 characters.");
    setLoading(true);
    try {
      await db.ryte.signIn(password);
      props.onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View>
      <Title
        title={
          isNew === false
            ? "Enter your encryption password"
            : "Choose an encryption password"
        }
        text={
          isNew === undefined
            ? `Looking for Ryte data in ${status.displayName}…`
            : isNew
              ? `Connected to ${status.displayName} as ${status.email}. Your notes are encrypted with this password before they leave this device. It cannot be recovered: if you forget it, your synced notes cannot be decrypted.`
              : `Connected to ${status.displayName} as ${status.email}. Enter the encryption password you chose when you first set up Ryte.`
        }
      />
      <View
        style={{
          paddingHorizontal: DefaultAppStyles.GAP,
          gap: DefaultAppStyles.GAP_VERTICAL
        }}
      >
        <FormInput
          name="password"
          formRef={formRef}
          testID="input.encryptionPassword"
          returnKeyType={isNew ? "next" : "done"}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          marginBottom={0}
          placeholder="Encryption password"
          editable={!loading && isNew !== undefined}
          validators={[validators.required("Enter your encryption password.")]}
          onSubmitEditing={() =>
            isNew ? confirmRef.current?.focus() : unlock()
          }
        />
        {isNew ? (
          <FormInput
            name="confirm"
            formRef={formRef}
            fwdRef={confirmRef}
            testID="input.confirmEncryptionPassword"
            returnKeyType="done"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            marginBottom={0}
            placeholder="Confirm encryption password"
            editable={!loading}
            onSubmitEditing={unlock}
          />
        ) : null}
        {error ? (
          <Paragraph size={AppFontSize.sm} color={colors.error.paragraph}>
            {error}
          </Paragraph>
        ) : null}
        <Button
          loading={loading || isNew === undefined}
          onPress={unlock}
          style={{ width: "100%" }}
          type="accent"
          title={
            loading || isNew === undefined
              ? null
              : isNew
                ? "Create & start syncing"
                : "Unlock"
          }
          fontSize={AppFontSize.sm}
        />
        <Button
          title="Use another account"
          style={{ width: "100%" }}
          onPress={() => !loading && props.onChangeStorage()}
          type="secondaryAccented"
        />
      </View>
    </View>
  );
}
