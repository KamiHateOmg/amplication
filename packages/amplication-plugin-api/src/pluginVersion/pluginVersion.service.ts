import { forwardRef, Inject, Injectable } from "@nestjs/common";
import {
  Plugin,
  PluginVersion,
  Prisma,
} from "../../prisma/generated-prisma-client";
import fetch from "node-fetch";
import zlib from "zlib";
import tar from "tar-stream";
import { PrismaService } from "../prisma/prisma.service";
import { PluginVersionServiceBase } from "./base/pluginVersion.service.base";
import { PluginService } from "../plugin/plugin.service";
import { NpmPluginVersionService } from "./npm-plugin-version.service";
import { AmplicationLogger } from "@amplication/util/nestjs/logging";

const SETTINGS_FILE = "package/.amplicationrc.json";

@Injectable()
export class PluginVersionService extends PluginVersionServiceBase {
  constructor(
    protected readonly prisma: PrismaService,
    @Inject(forwardRef(() => PluginService))
    private pluginService: PluginService,
    private npmPluginVersionService: NpmPluginVersionService,
    @Inject(AmplicationLogger) readonly logger: AmplicationLogger
  ) {
    super(prisma);
  }
  async upsert<T extends Prisma.PluginVersionUpsertArgs>(
    args: Prisma.SelectSubset<T, Prisma.PluginVersionUpsertArgs>
  ): Promise<PluginVersion> {
    return this.prisma.pluginVersion.upsert(args);
  }
  /**
   * get all saved plugin from DB
   * @returns Plugin[]
   */
  async getPlugins(): Promise<Plugin[]> {
    try {
      return await this.pluginService.findMany({});
    } catch (error) {
      /* empty */
    }
  }
  /**
   * fetch the settings of a specific package version from npm as part of the creation of plugin version.
   * it search for `.amplicationrc.json
   * this function will run only one time, during the creation of a plugin version
   * @param tarBallUrl
   * @returns
   */
  async getPluginSettings(
    tarBallUrl: string,
    fileName: string
  ): Promise<string> {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      try {
        const extract = tar.extract();
        extract.on("entry", function (header, stream, next) {
          if (header.name === fileName) {
            stream.on("data", (chunk) => {
              const data = Buffer.from(chunk);

              return resolve(data.toString().replace(/ |\n/g, ""));
            });
          }

          stream.on("end", function () {
            next();
          });

          stream.resume();
        });

        extract.on("finish", () => {
          return resolve("{}");
        });

        const res = await fetch(tarBallUrl);
        res.body.pipe(zlib.createGunzip()).pipe(extract);
      } catch (error) {
        this.logger.error("getPluginSettings", error, { tarBallUrl });
        reject(error);
      }
    });
  }

  /**
   * main service function.upsert all plugins versions into DB
   * @returns Plugin[]
   */
  async processPluginsVersions(plugins: Plugin[]) {
    try {
      const pluginsVersions =
        await this.npmPluginVersionService.updatePluginsVersion(plugins);
      if (!pluginsVersions.length)
        throw new Error("Failed to fetch versions for plugin");

      const pluginVersionArr: Omit<PluginVersion, "id">[] = [];

      const pluginVersionsSettingsPromises = await Promise.allSettled(
        pluginsVersions.map(async (versionData) => {
          const { version, tarballUrl } = versionData;
          const pluginSettings = await this.getPluginSettings(
            tarballUrl,
            SETTINGS_FILE
          );
          return { version, pluginSettings };
        })
      );
      const pluginVersionsSettings = pluginVersionsSettingsPromises
        .map((result) => {
          if (result.status === "fulfilled") return result.value;
          return undefined;
        })
        .filter((versionSettings) => versionSettings !== undefined);

      for (const versionData of pluginsVersions) {
        const {
          createdAt,
          deprecated,
          pluginId,
          updatedAt,
          version,
          pluginIdVersion,
          isLatest,
        } = versionData;

        const pluginSettings = pluginVersionsSettings.find(
          (versionSettings) => versionSettings.version === version
        ).pluginSettings;

        if (pluginSettings) {
          pluginVersionArr.push({
            pluginId,
            pluginIdVersion,
            isLatest,
            settings: pluginSettings,
            deprecated,
            version,
            createdAt,
            updatedAt,
          });
        }
      }

      const newVersions = await this.prisma.pluginVersion.createMany({
        data: pluginVersionArr,
        skipDuplicates: true,
      });

      this.logger.debug("New PluginVersions", newVersions);

      const deprecatedVersionIds = pluginVersionArr
        .filter((version) => version.deprecated)
        .map((version) => version.pluginIdVersion);

      const updateNewDeprecatedVersions = await this.prisma.$transaction([
        this.prisma.pluginVersion.updateMany({
          data: {
            deprecated: "deprecated",
            updatedAt: new Date(),
          },
          where: {
            pluginIdVersion: {
              in: deprecatedVersionIds,
            },
            deprecated: {
              not: "deprecated",
            },
          },
        }),
        this.prisma.pluginVersion.updateMany({
          data: {
            deprecated: null,
            updatedAt: new Date(),
          },
          where: {
            pluginIdVersion: {
              notIn: deprecatedVersionIds,
            },
            deprecated: {
              equals: "deprecated",
            },
          },
        }),
      ]);

      const latestVersionIds = pluginVersionArr
        .filter((version) => version.isLatest)
        .map((version) => version.pluginIdVersion);

      const updateNewLatestVersions = await this.prisma.$transaction([
        this.prisma.pluginVersion.updateMany({
          data: {
            isLatest: true,
            updatedAt: new Date(),
          },
          where: {
            pluginIdVersion: {
              in: latestVersionIds,
            },
          },
        }),

        this.prisma.pluginVersion.updateMany({
          data: {
            isLatest: false,
            updatedAt: new Date(),
          },
          where: {
            pluginIdVersion: {
              notIn: latestVersionIds,
            },
          },
        }),
      ]);

      this.logger.debug(
        "Updated versions",
        [updateNewDeprecatedVersions, updateNewLatestVersions]
          .flat()
          .reduce((acc, curr) => acc + curr.count, 0)
      );

      return pluginsVersions;
    } catch (error) {
      this.logger.error("npmPluginsVersions", error, {});
      throw error;
    }
  }

  async findMany(
    args: Prisma.PluginVersionFindManyArgs
  ): Promise<PluginVersion[]> {
    const versions = await super.findMany(args);

    const latestVersion = versions.find((version) => version.isLatest);

    if (latestVersion) {
      versions.unshift({
        ...latestVersion,
        id: "latest",
        version: "latest",
      });
    }
    return versions;
  }
}
